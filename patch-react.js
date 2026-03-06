#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '../..');
const PACKAGES_DIR = path.join(PROJECT_ROOT, 'Packages');
const REACT_RECONCILER_DIR = path.join(PACKAGES_DIR, 'index/jsdotlua_react-reconciler@17.2.1/react-reconciler/src');
const REACT_ROBLOX_DIR = path.join(PACKAGES_DIR, 'index/jsdotlua_react-roblox@17.2.1/react-roblox/src');
const REACT_CHARM_DIR = path.join(PACKAGES_DIR, 'index/littensy_react-charm@0.3.0/react-charm/src');
const REACT_RIPPLE_DIR = path.join(PACKAGES_DIR, 'index/littensy_react-ripple@3.0.1/react-ripple/src');

console.log('🔧 Patching React lazy loading for darklua compatibility...\n');

/**
 * Rename all init.luau/init.lua files to _init.luau/_init.lua
 */
function renameInitFiles(dir) {
  let filesRenamed = 0;

  if (!fs.existsSync(dir)) {
    return filesRenamed;
  }

  const files = fs.readdirSync(dir);

  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      filesRenamed += renameInitFiles(filePath);
    } else if (file === 'init.luau' || file === 'init.lua') {
      const newName = file.replace('init', '_init');
      const newPath = path.join(dir, newName);
      fs.renameSync(filePath, newPath);
      filesRenamed++;
      console.log(`  ✓ Renamed ${path.relative(PROJECT_ROOT, filePath)} → ${newName}`);
    }
  }

  return filesRenamed;
}

/**
 * Update all requires that reference init files to use _init with correct paths
 */
function updateInitReferences(dir) {
  let filesUpdated = 0;

  if (!fs.existsSync(dir)) {
    return filesUpdated;
  }

  const files = fs.readdirSync(dir);

  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      filesUpdated += updateInitReferences(filePath);
    } else if (file.endsWith('.luau') || file.endsWith('.lua')) {
      let content = fs.readFileSync(filePath, 'utf8');
      const original = content;

      // Replace require paths ending with /init, checking for src/lib subdirectories
      content = content.replace(/require\(["']([^"']+)\/(init|_init)(?:\.luau|\.lua)?["']\)/g, (match, basePath, initName) => {
        // Resolve the absolute path from the current file
        const fileDir = path.dirname(filePath);
        const targetPath = path.resolve(fileDir, basePath);

        // Check if _init exists in src/ or lib/
        if (fs.existsSync(path.join(targetPath, 'src/_init.lua')) || fs.existsSync(path.join(targetPath, 'src/_init.luau'))) {
          return `require("${basePath}/src/_init")`;
        } else if (fs.existsSync(path.join(targetPath, 'lib/_init.lua')) || fs.existsSync(path.join(targetPath, 'lib/_init.luau'))) {
          return `require("${basePath}/lib/_init")`;
        } else if (fs.existsSync(path.join(targetPath, '_init.lua')) || fs.existsSync(path.join(targetPath, '_init.luau'))) {
          return `require("${basePath}/_init")`;
        }
        // If we can't find it, just convert init to _init
        return `require("${basePath}/_init")`;
      });

      // Handle relative paths like ./init or ../init
      content = content.replace(/require\(["']((?:\.\.?\/)+)(init|_init)(?:\.luau|\.lua)?["']\)/g, (match, relativePath, initName) => {
        const fileDir = path.dirname(filePath);
        const targetPath = path.resolve(fileDir, relativePath);

        if (fs.existsSync(path.join(targetPath, 'src/_init.lua')) || fs.existsSync(path.join(targetPath, 'src/_init.luau'))) {
          return `require("${relativePath}src/_init")`;
        } else if (fs.existsSync(path.join(targetPath, 'lib/_init.lua')) || fs.existsSync(path.join(targetPath, 'lib/_init.luau'))) {
          return `require("${relativePath}lib/_init")`;
        } else if (fs.existsSync(path.join(targetPath, '_init.lua')) || fs.existsSync(path.join(targetPath, '_init.luau'))) {
          return `require("${relativePath}_init")`;
        }
        return `require("${relativePath}_init")`;
      });

      // Handle bare "init" or "_init"
      content = content.replace(/require\(["'](init|_init)["']\)/g, 'require("_init")');

      if (content !== original) {
        fs.writeFileSync(filePath, content, 'utf8');
        filesUpdated++;
      }
    }
  }

  return filesUpdated;
}

/**
 * Fix wrapper files in Packages root to point to correct _init paths
 */
function fixWrapperFiles() {
  let filesFixed = 0;
  const wrapperFiles = fs.readdirSync(PACKAGES_DIR).filter(f => f.endsWith('.lua') || f.endsWith('.luau'));

  for (const file of wrapperFiles) {
    const filePath = path.join(PACKAGES_DIR, file);
    let content = fs.readFileSync(filePath, 'utf8');
    const original = content;

    // Pattern: return require("./index/package@version/module/_init")
    // Should be: return require("./index/package@version/module/src/_init") (or lib/_init)
    content = content.replace(/return require\("(\.\/index\/[^\/]+\/([^\/]+))\/_init"\)/, (match, basePath, moduleName) => {
      const moduleDir = path.join(PACKAGES_DIR, basePath.replace('./', ''));

      // Check where the _init file actually is
      if (fs.existsSync(path.join(moduleDir, 'src/_init.lua')) || fs.existsSync(path.join(moduleDir, 'src/_init.luau'))) {
        return `return require("${basePath}/src/_init")`;
      } else if (fs.existsSync(path.join(moduleDir, 'lib/_init.lua')) || fs.existsSync(path.join(moduleDir, 'lib/_init.luau'))) {
        return `return require("${basePath}/lib/_init")`;
      }
      return match; // Keep as-is if not found in common locations
    });

    if (content !== original) {
      fs.writeFileSync(filePath, content, 'utf8');
      filesFixed++;
      console.log(`  ✓ Fixed ${file}`);
    }
  }

  return filesFixed;
}

/**
 * Create the module registry with lazy proxy support
 */
function createRegistries() {
  const registryContent = `local registry = {}

return {
	register = function(name, module)
		registry[name] = module
	end,
	get = function(name)
		return registry[name]
	end,
	lazy = function(name)
		return setmetatable({}, {
			__index = function(_, key)
				local mod = registry[name]
				if mod then
					return mod[key]
				end
				return nil
			end,
			__newindex = function(_, key, value)
				local mod = registry[name]
				if mod then
					mod[key] = value
				end
			end,
		})
	end,
}
`;

  const registryPath = path.join(REACT_RECONCILER_DIR, 'ReactModuleRegistry.luau');
  fs.writeFileSync(registryPath, registryContent, 'utf8');
  console.log(`  ✓ Created ReactModuleRegistry.luau`);

  const robloxRegistryPath = path.join(REACT_ROBLOX_DIR, 'client/ReactRobloxModuleRegistry.luau');
  fs.writeFileSync(robloxRegistryPath, registryContent, 'utf8');
  console.log(`  ✓ Created ReactRobloxModuleRegistry.luau`);
}

/**
 * Patterns to patch files to register themselves and use the registry
 */
const MODULE_REGISTRATIONS = [
  {
    file: 'ReactFiberWorkLoop.new.luau',
    moduleName: 'ReactFiberWorkLoop'
  },
  {
    file: 'ReactFiberBeginWork.new.luau',
    moduleName: 'ReactFiberBeginWork'
  },
  {
    file: 'ReactFiberHooks.new.luau',
    moduleName: 'ReactFiberHooks'
  },
  {
    file: 'ReactFiberReconciler.luau',
    moduleName: 'ReactFiberReconciler'
  },
  {
    file: 'ReactFiberNewContext.new.luau',
    moduleName: 'ReactFiberNewContext'
  },
  // Roblox-side registrations
  {
    file: 'ReactRobloxComponentTree.luau',
    moduleName: 'ReactRobloxComponentTree'
  },
];

/**
 * Circular dependency patches using the registry
 */
const CIRCULAR_REQUIRES = [
  // ReactFiberWorkLoop <-> ReactFiberUnwindWork
  {
    file: 'ReactFiberUnwindWork.new.luau',
    pattern: /(\t+)(popRenderLanesRef = require\("\.\/ReactFiberWorkLoop\.new"\)\.popRenderLanes)/g,
    replacement: '$1popRenderLanesRef = nil'
  },
  // ReactFiberWorkLoop <-> ReactFiberThrow
  {
    file: 'ReactFiberThrow.new.luau',
    pattern: /(\s+)(ReactFiberWorkLoop = )(require\("\.\/ReactFiberWorkLoop\.new"\))/g,
    replacement: '$1local ReactModuleRegistry = require("./ReactModuleRegistry")\n$1$2ReactModuleRegistry.lazy("ReactFiberWorkLoop")'
  },
  // ReactFiberBeginWork <-> ReactFiberReconciler
  {
    file: 'ReactFiberBeginWork.new.luau',
    pattern: /(\t+)(lazyRefs\.shouldSuspendRef = require\("\.\/ReactFiberReconciler"\)\.shouldSuspend)/g,
    replacement: '$1local ReactModuleRegistry = require("./ReactModuleRegistry")\n$1local _lazyReconciler = ReactModuleRegistry.lazy("ReactFiberReconciler")\n$1lazyRefs.shouldSuspendRef = function(fiber)\n$1\treturn _lazyReconciler.shouldSuspend and _lazyReconciler.shouldSuspend(fiber) or false\n$1end'
  },
  // ReactFiberHooks <-> ReactFiberBeginWork
  {
    file: 'ReactFiberHooks.new.luau',
    pattern: /local markWorkInProgressReceivedUpdate =\s+require\("\.\/ReactFiberBeginWork\.new"\)\.markWorkInProgressReceivedUpdate ::? any/g,
    replacement: 'local ReactModuleRegistry = require("./ReactModuleRegistry")\nlocal _lazyBeginWork = ReactModuleRegistry.lazy("ReactFiberBeginWork")\nlocal markWorkInProgressReceivedUpdate = function(...)\n\treturn _lazyBeginWork.markWorkInProgressReceivedUpdate(...)\nend'
  },
  // ReactFiberHooks <-> ReactFiberWorkLoop (main require)
  {
    file: 'ReactFiberHooks.new.luau',
    pattern: /local ReactFiberWorkLoop = require\("\.\/ReactFiberWorkLoop\.new"\)(::? any)?/g,
    replacement: 'local ReactModuleRegistry = require("./ReactModuleRegistry")\nlocal ReactFiberWorkLoop = ReactModuleRegistry.lazy("ReactFiberWorkLoop")'
  },
  // ReactFiberBeginWork <-> ReactFiberHooks
  {
    file: 'ReactFiberBeginWork.new.luau',
    pattern: /(\t)(local ReactFiberHooks = require\("\.\/ReactFiberHooks\.new"\))/g,
    replacement: '$1local ReactModuleRegistry = require("./ReactModuleRegistry")\n$1local ReactFiberHooks = ReactModuleRegistry.lazy("ReactFiberHooks")'
  },
  // ReactFiberBeginWork <-> ReactFiberWorkLoop
  {
    file: 'ReactFiberBeginWork.new.luau',
    pattern: /local ReactFiberWorkLoop = require\("\.\/ReactFiberWorkLoop\.new"\)(::? any)?/g,
    replacement: 'local ReactModuleRegistry = require("./ReactModuleRegistry")\nlocal ReactFiberWorkLoop = ReactModuleRegistry.lazy("ReactFiberWorkLoop")'
  },
  // ReactFiberCompleteWork <-> ReactFiberWorkLoop
  {
    file: 'ReactFiberCompleteWork.new.luau',
    pattern: /local ReactFiberWorkLoop = require\("\.\/ReactFiberWorkLoop\.new"\)(::? any)?/g,
    replacement: 'local ReactModuleRegistry = require("./ReactModuleRegistry")\nlocal ReactFiberWorkLoop = ReactModuleRegistry.lazy("ReactFiberWorkLoop")'
  },
  // ReactFiberClassComponent <-> ReactFiberWorkLoop
  {
    file: 'ReactFiberClassComponent.new.luau',
    pattern: /(\t)(local ReactFiberWorkLoop = require\("\.\/ReactFiberWorkLoop\.new"\))/g,
    replacement: '$1local ReactModuleRegistry = require("./ReactModuleRegistry")\n$1local ReactFiberWorkLoop = ReactModuleRegistry.lazy("ReactFiberWorkLoop")'
  },
  // ReactFiberCommitWork <-> ReactFiberBeginWork
  {
    file: 'ReactFiberCommitWork.new.luau',
    pattern: /didWarnAboutReassigningPropsRef =\s+require\("\.\/ReactFiberBeginWork\.new"\)\.didWarnAboutReassigningProps/g,
    replacement: 'local ReactModuleRegistry = require("./ReactModuleRegistry")\n\t\tlocal _lazyBeginWork = ReactModuleRegistry.lazy("ReactFiberBeginWork")\n\t\tdidWarnAboutReassigningPropsRef = _lazyBeginWork.didWarnAboutReassigningProps or false'
  },
  // ReactRobloxHostConfig <-> ReactRobloxComponentTree
  {
    file: 'ReactRobloxHostConfig.luau',
    pattern: /local ReactRobloxComponentTree = require\("\.\/ReactRobloxComponentTree"\)/g,
    replacement: 'local ReactRobloxModuleRegistry = require("./ReactRobloxModuleRegistry")\nlocal ReactRobloxComponentTree = ReactRobloxModuleRegistry.lazy("ReactRobloxComponentTree")'
  },
  // ReactRobloxComponentTree <-> ReactReconciler
  {
    file: 'ReactRobloxComponentTree.luau',
    pattern: /(local ReactReconciler = require\("\.\.\/ReactReconciler\.roblox"\)::? any)/g,
    replacement: 'local ReactRobloxModuleRegistry = require("./ReactRobloxModuleRegistry")\n\t\tlocal ReactReconciler = ReactRobloxModuleRegistry.lazy("ReactReconciler")'
  },
  // ReactReconciler.roblox needs to register itself so ReactRobloxComponentTree can find it
  {
    file: 'ReactReconciler.roblox.luau',
    pattern: /return (initializeReconciler\(ReactRobloxHostConfig\))/g,
    replacement: 'local _reconcilerExports = $1\nlocal ReactRobloxModuleRegistry = require("./client/ReactRobloxModuleRegistry")\nReactRobloxModuleRegistry.register("ReactReconciler", _reconcilerExports)\nreturn _reconcilerExports'
  }
];

function addModuleRegistration(content, filePath, moduleName) {
  // Check if already has registration
  if (content.includes('ReactModuleRegistry.register') || content.includes('ReactRobloxModuleRegistry.register')) {
    return content;
  }

  const isRoblox = filePath.includes('react-roblox');
  const registryName = isRoblox ? 'ReactRobloxModuleRegistry' : 'ReactModuleRegistry';

  // Find the return statement at the end
  const lines = content.split('\n');
  let returnIndex = -1;

  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim().startsWith('return ')) {
      returnIndex = i;
      break;
    }
  }

  if (returnIndex === -1) {
    console.warn(`  ⚠️  No return statement found in ${path.basename(filePath)}`);
    return content;
  }

  // Insert registration before return
  const returnLine = lines[returnIndex];
  const returnValue = returnLine.trim().substring(7).trim(); // Remove "return "

  lines.splice(returnIndex, 0,
    `local ${registryName} = require("./${registryName}")`,
    `local exports = ${returnValue}`,
    `${registryName}.register("${moduleName}", exports)`
  );
  lines[returnIndex + 3] = 'return exports';

  return lines.join('\n');
}

function patchLazyLoading(content, filePath) {
  let modified = content;
  let patchCount = 0;

  const fileName = path.basename(filePath);

  // Add module registration if needed
  const registration = MODULE_REGISTRATIONS.find(r => r.file === fileName);
  if (registration) {
    const withRegistration = addModuleRegistration(modified, filePath, registration.moduleName);
    if (withRegistration !== modified) {
      modified = withRegistration;
      console.log(`  ✓ ${path.relative(PROJECT_ROOT, filePath)} - Added module registration`);
    }
  }

  // Check if this file has a known circular dependency
  for (const circular of CIRCULAR_REQUIRES) {
    if (fileName === circular.file) {
      const before = modified;
      modified = modified.replace(circular.pattern, circular.replacement);
      if (modified !== before) {
        patchCount++;
        console.log(`  ✓ ${path.relative(PROJECT_ROOT, filePath)} - Patched circular dependency with registry`);
      }
    }
  }

  // Pattern: if not ModuleName then ModuleName = require("...") end
  // The original code defers requires to break circular deps. Since darklua can't
  // handle conditional requires, we replace with a lazy registry proxy that defers
  // the actual lookup to access time via __index metamethod.
  const lazyLoadPattern = /if not (\w+) then\s+(\1) = require\("([^"]+)"\)(?:::? any)?\s+end/g;

  modified = modified.replace(lazyLoadPattern, (match, moduleName, _, requirePath) => {
    if (!match.includes('-- PATCHED')) {
      patchCount++;
      // Extract the module name from the require path (e.g. "./ReactFiberWorkLoop.new" -> "ReactFiberWorkLoop")
      const modBaseName = requirePath.replace(/^\.\//, '').replace(/\.new$/, '');
      const isRoblox = filePath.includes('react-roblox');
      const registryName = isRoblox ? 'ReactRobloxModuleRegistry' : 'ReactModuleRegistry';
      return `if not ${moduleName} then\n\t\t${moduleName} = require("./${registryName}").lazy("${modBaseName}")\n\tend`;
    }
    return match;
  });

  // Pattern: Standalone lazy require in conditionals (not closed with end on same match)
  const conditionalRequirePattern = /if not (\w+) then\s+(\1) = require\("([^"]+)"\)(?:::? any)?\s+/g;

  modified = modified.replace(conditionalRequirePattern, (match, moduleName, _, requirePath) => {
    if (!match.includes('-- PATCHED')) {
      patchCount++;
      const modBaseName = requirePath.replace(/^\.\//, '').replace(/\.new$/, '');
      const isRoblox = filePath.includes('react-roblox');
      const registryName = isRoblox ? 'ReactRobloxModuleRegistry' : 'ReactModuleRegistry';
      return `if not ${moduleName} then\n\t\t${moduleName} = require("./${registryName}").lazy("${modBaseName}")\n\t`;
    }
    return match;
  });

  if (patchCount > 0 && !fileName.match(/^(ReactFiber|ReactRoblox)/) && !registration) {
    console.log(`  ✓ ${path.relative(PROJECT_ROOT, filePath)} - ${patchCount} pattern(s) patched`);
  }

  // Fix deferred module destructures (e.g. ReactFiberHostConfig is populated after load)
  modified = fixDeferredModuleDestructures(modified, filePath);

  return modified;
}

function processDirectory(dir) {
  let filesPatched = 0;

  if (!fs.existsSync(dir)) {
    console.warn(`⚠️  Directory not found: ${dir}`);
    return filesPatched;
  }

  const files = fs.readdirSync(dir);

  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      filesPatched += processDirectory(filePath);
    } else if (file.endsWith('.luau') || file.endsWith('.lua')) {
      const originalContent = fs.readFileSync(filePath, 'utf8');
      const patchedContent = patchLazyLoading(originalContent, filePath);

      if (originalContent !== patchedContent) {
        fs.writeFileSync(filePath, patchedContent, 'utf8');
        filesPatched++;
      }
    }
  }

  return filesPatched;
}

/**
 * Extract export type declarations from a Luau file, preserving generic parameters.
 * Returns an array of objects: { name, generics, full }
 *   name:     "Atom"
 *   generics: "<State>"  (or "" if none)
 *   full:     "Atom<State>"
 */
function extractTypeExports(content) {
  const typeExports = [];
  // Captures: name, optional generic params (including angle brackets)
  const exportTypeRegex = /^export type\s+([a-zA-Z0-9_]+)\s*(<[^=][^\n]*?>)?/gm;
  let match;
  while ((match = exportTypeRegex.exec(content)) !== null) {
    const name = match[1];
    const generics = (match[2] || '').trim();
    typeExports.push({ name, generics, full: name + generics });
  }
  return typeExports;
}

/**
 * Find the actual module file path given a require path
 */
function findModuleFile(basePath, requirePath) {
  const absolutePath = path.join(basePath, requirePath);

  // Try direct paths first
  const directPaths = [absolutePath + '.lua', absolutePath + '.luau'];
  for (const tryPath of directPaths) {
    if (fs.existsSync(tryPath)) return tryPath;
  }

  // Check if it's a directory - look for _init files
  if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isDirectory()) {
    const initPaths = [
      path.join(absolutePath, 'src/_init.luau'),
      path.join(absolutePath, 'src/_init.lua'),
      path.join(absolutePath, 'lib/_init.luau'),
      path.join(absolutePath, 'lib/_init.lua'),
      path.join(absolutePath, '_init.luau'),
      path.join(absolutePath, '_init.lua')
    ];
    for (const tryPath of initPaths) {
      if (fs.existsSync(tryPath)) return tryPath;
    }
  }

  return null;
}

/**
 * Update wrapper files in Packages root to re-export types
 */
function updateWrapperTypes() {
  let filesUpdated = 0;

  const wrapperFiles = fs.readdirSync(PACKAGES_DIR)
    .filter(f => (f.endsWith('.lua') || f.endsWith('.luau')) &&
                 fs.statSync(path.join(PACKAGES_DIR, f)).isFile());

  for (const wrapperFile of wrapperFiles) {
    const wrapperPath = path.join(PACKAGES_DIR, wrapperFile);
    const wrapperContent = fs.readFileSync(wrapperPath, 'utf8');

    // Extract the require path from the wrapper
    const requireMatch = wrapperContent.match(/require\(["']([^"']+)["']\)/);
    if (!requireMatch) continue;

    const requirePath = requireMatch[1];
    const targetFilePath = findModuleFile(PACKAGES_DIR, requirePath);

    if (!targetFilePath) continue;

    // Read the target module and extract type exports
    const targetContent = fs.readFileSync(targetFilePath, 'utf8');
    const typeExports = extractTypeExports(targetContent);

    if (typeExports.length === 0) continue;

    // Generate new wrapper content with type re-exports (preserving generics)
    const moduleName = path.basename(wrapperFile, path.extname(wrapperFile));
    const typeLines = typeExports.map(t => {
      if (t.generics) {
        // Strip defaults from generics for the LHS (Luau re-export syntax)
        // e.g. "<T = any>" → keep as-is on LHS, pass "<T>" on RHS
        const lhs = t.generics; // e.g. "<T = any>"
        const rhs = t.generics.replace(/\s*=[^,>]+/g, ''); // e.g. "<T>"
        return `export type ${t.name}${lhs} = ${moduleName}.${t.name}${rhs}`;
      }
      return `export type ${t.name} = ${moduleName}.${t.name}`;
    });
    const newWrapperContent = `local ${moduleName} = require("${requirePath}")

${typeLines.join('\n')}

return ${moduleName}
`;

    if (wrapperContent !== newWrapperContent) {
      fs.writeFileSync(wrapperPath, newWrapperContent, 'utf8');
      console.log(`  ✓ ${wrapperFile} (${typeExports.length} types)`);
      filesUpdated++;
    }
  }

  return filesUpdated;
}

/**
 * Escape special regex characters in a string
 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Modules that are populated after initial load (via initialize() or similar).
 * Destructuring from these at load time captures nil. Instead, we replace
 * local X = Module.X with direct Module.X access at usage sites.
 */
const DEFERRED_MODULES = [
  'ReactFiberHostConfig',       // Empty shim populated by initialize() at runtime
  'ReactFiberWorkLoop',         // Loaded from ReactModuleRegistry, may not be registered yet
  'ReactRobloxComponentTree',   // Loaded from ReactRobloxModuleRegistry, may not be registered yet
  'ReactFiberHooks',            // Loaded from ReactModuleRegistry, may not be registered yet
  'ReactFiberBeginWork',        // Loaded from ReactModuleRegistry, may not be registered yet
  'ReactFiberReconciler',       // Loaded from ReactModuleRegistry, may not be registered yet
];

/**
 * Fix destructuring from deferred modules whose properties are nil at load time.
 * Removes `local X = DeferredModule.Y` and replaces all usages with `DeferredModule.Y`.
 */
function fixDeferredModuleDestructures(content, filePath) {
  const lines = content.split('\n');
  const linesToRemove = new Set();
  const replacements = []; // { from, to }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Only check top-level locals (no indentation)
    if (!line.startsWith('local ')) continue;

    // Single-line: local X = Module.Y
    let match = line.match(/^local\s+(\w+)\s*=\s*(\w+)\.(\w+)\s*$/);
    if (match && DEFERRED_MODULES.includes(match[2])) {
      linesToRemove.add(i);
      replacements.push({ from: match[1], to: `${match[2]}.${match[3]}` });
      continue;
    }

    // Multi-line: local X =\n\tModule.Y
    match = line.match(/^local\s+(\w+)\s*=\s*$/);
    if (match && i + 1 < lines.length) {
      const nextLine = lines[i + 1];
      const nextMatch = nextLine.match(/^\t+(\w+)\.(\w+)\s*$/);
      if (nextMatch && DEFERRED_MODULES.includes(nextMatch[1])) {
        linesToRemove.add(i);
        linesToRemove.add(i + 1);
        replacements.push({ from: match[1], to: `${nextMatch[1]}.${nextMatch[2]}` });
        continue;
      }
    }
  }

  if (replacements.length === 0) return content;

  // Sort by name length (longest first) to avoid partial matches
  replacements.sort((a, b) => b.from.length - a.from.length);

  const result = [];
  for (let i = 0; i < lines.length; i++) {
    if (linesToRemove.has(i)) continue;

    let line = lines[i];

    // Skip comment lines
    if (line.trim().startsWith('--')) {
      result.push(line);
      continue;
    }

    for (const { from, to } of replacements) {
      if (!line.includes(from)) continue;

      line = line.replace(
        new RegExp(`(?<![\\w.])${escapeRegex(from)}(?!\\w)`, 'g'),
        (match, offset, str) => {
          if (str.substring(0, offset).match(/local\s+$/)) return match;
          // Don't replace table keys: { X = ... } — X is followed by \s*= but not ==
          const after = str.substring(offset + match.length);
          if (after.match(/^\s*=[^=]/)) return match;
          const before = str.substring(0, offset);
          const dq = (before.match(/"/g) || []).length;
          const sq = (before.match(/'/g) || []).length;
          if (dq % 2 !== 0 || sq % 2 !== 0) return match;
          return to;
        },
      );
    }

    result.push(line);
  }

  const fileName = path.basename(filePath);
  console.log(`  ✓ ${fileName}: Deferred ${replacements.length} host config destructure(s) to table access`);
  return result.join('\n');
}

/**
 * Fix files that exceed Luau's 200 local variable limit by consolidating
 * destructured locals (local X = Module.X) back into module table access.
 */
function fixLocalVariableLimit(content, filePath, threshold = 190) {
  const lines = content.split('\n');

  // Step 1: Count top-level locals and find destructuring groups
  let topLevelLocalCount = 0;
  const destructureGroups = {}; // moduleName -> [{ lineIndices, localName, propName }]

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('--')) continue;

    // Only count top-level locals (no leading whitespace)
    if (!line.startsWith('local ')) continue;

    topLevelLocalCount++;

    // Check for single-line destructure: local X = Module.Y
    let match = line.match(/^local\s+(\w+)\s*=\s*(\w+)\.(\w+)\s*$/);
    if (match) {
      const [, localName, moduleName, propName] = match;
      if (!destructureGroups[moduleName]) destructureGroups[moduleName] = [];
      destructureGroups[moduleName].push({
        lineIndices: [i],
        localName,
        propName,
      });
      continue;
    }

    // Check for multi-line destructure: local X =\n\tModule.Y
    match = line.match(/^local\s+(\w+)\s*=\s*$/);
    if (match && i + 1 < lines.length) {
      const nextLine = lines[i + 1];
      const nextMatch = nextLine.match(/^\t+(\w+)\.(\w+)\s*$/);
      if (nextMatch) {
        const localName = match[1];
        const [, moduleName, propName] = nextMatch;
        if (!destructureGroups[moduleName]) destructureGroups[moduleName] = [];
        destructureGroups[moduleName].push({
          lineIndices: [i, i + 1],
          localName,
          propName,
        });
        continue;
      }
    }
  }

  if (topLevelLocalCount < threshold) return content;

  const fileName = path.basename(filePath);
  console.log(`  ⚠ ${fileName}: ${topLevelLocalCount} top-level locals (limit: 200)`);

  // Step 2: Sort groups by size (largest first)
  const sortedGroups = Object.entries(destructureGroups)
    .filter(([, members]) => members.length >= 3)
    .sort(([, a], [, b]) => b.length - a.length);

  if (sortedGroups.length === 0) {
    console.log(`  ⚠ ${fileName}: No destructure groups large enough to consolidate`);
    return content;
  }

  let excess = topLevelLocalCount - threshold;
  const linesToRemove = new Set();
  const replacements = []; // { from, to }

  for (const [moduleName, members] of sortedGroups) {
    if (excess <= 0) break;

    for (const member of members) {
      if (excess <= 0) break;

      for (const lineIdx of member.lineIndices) {
        linesToRemove.add(lineIdx);
      }

      replacements.push({
        from: member.localName,
        to: `${moduleName}.${member.propName}`,
      });

      excess--;
    }
  }

  if (replacements.length === 0) return content;

  // Sort replacements by name length (longest first) to avoid partial matches
  replacements.sort((a, b) => b.from.length - a.from.length);

  // Step 3: Remove declaration lines and replace usages
  const result = [];
  for (let i = 0; i < lines.length; i++) {
    if (linesToRemove.has(i)) continue;

    let line = lines[i];
    const trimmed = line.trim();

    // Skip comment lines
    if (trimmed.startsWith('--')) {
      result.push(line);
      continue;
    }

    // Apply replacements
    for (const { from, to } of replacements) {
      if (!line.includes(from)) continue;

      line = line.replace(
        new RegExp(`(?<![\\w.])${escapeRegex(from)}(?!\\w)`, 'g'),
        (match, offset, str) => {
          // Don't replace if this is a local declaration of the same name
          if (str.substring(0, offset).match(/local\s+$/)) return match;
          // Don't replace table keys: { X = ... } — X is followed by \s*= but not ==
          const after = str.substring(offset + match.length);
          if (after.match(/^\s*=[^=]/)) return match;

          // Don't replace inside strings (simple quote-counting heuristic)
          const before = str.substring(0, offset);
          const dq = (before.match(/"/g) || []).length;
          const sq = (before.match(/'/g) || []).length;
          if (dq % 2 !== 0 || sq % 2 !== 0) return match;

          return to;
        },
      );
    }

    result.push(line);
  }

  const saved = replacements.length;
  console.log(`  ✓ ${fileName}: Consolidated ${saved} destructured locals (${topLevelLocalCount} → ${topLevelLocalCount - saved})`);

  return result.join('\n');
}

/**
 * Recursively process directory to fix local variable limits
 */
function processDirectoryForLocalLimit(dir) {
  let filesFixed = 0;

  if (!fs.existsSync(dir)) {
    return filesFixed;
  }

  const files = fs.readdirSync(dir);

  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      filesFixed += processDirectoryForLocalLimit(filePath);
    } else if (file.endsWith('.luau') || file.endsWith('.lua')) {
      const originalContent = fs.readFileSync(filePath, 'utf8');
      const fixedContent = fixLocalVariableLimit(originalContent, filePath);

      if (originalContent !== fixedContent) {
        fs.writeFileSync(filePath, fixedContent, 'utf8');
        filesFixed++;
      }
    }
  }

  return filesFixed;
}

// Step 1: Rename all init files to _init
console.log('Step 1: Renaming init files to _init...');
let initFilesRenamed = renameInitFiles(PACKAGES_DIR);
console.log(`  ✓ Renamed ${initFilesRenamed} init file(s)\n`);

// Step 2: Update all requires referencing init files
console.log('Step 2: Updating init file references...');
let initReferencesUpdated = updateInitReferences(PACKAGES_DIR);
console.log(`  ✓ Updated ${initReferencesUpdated} file(s) with init references\n`);

// Step 2.5: Fix wrapper files to include src/lib paths
console.log('Step 2.5: Fixing wrapper file paths...');
let wrappersFixed = fixWrapperFiles();
console.log(`  ✓ Fixed ${wrappersFixed} wrapper file(s)\n`);

// Step 3: Create registry modules
console.log('Step 3: Creating module registries...');
createRegistries();

// Step 4: Patch React reconciler
console.log('\nStep 4: Patching React reconciler...');
let totalFilesPatched = processDirectory(REACT_RECONCILER_DIR);

// Step 5: Patch React Roblox
console.log('\nStep 5: Patching React Roblox...');
totalFilesPatched += processDirectory(REACT_ROBLOX_DIR);

if (totalFilesPatched > 0) {
  console.log(`\n✅ Patched ${totalFilesPatched} file(s) successfully!`);
  console.log('\n📝 Note: Modules now use ReactModuleRegistry to avoid circular dependencies.');
  console.log('   Each module registers itself and gets circular deps from the registry.');
} else {
  console.log('\n✨ No files needed patching (already patched or not present)');
}

// Step 6: Fix local variable limit (Luau has a 200 local limit per scope)
console.log('\nStep 6: Fixing local variable limit...');
let localLimitFixed = processDirectoryForLocalLimit(REACT_RECONCILER_DIR);
localLimitFixed += processDirectoryForLocalLimit(REACT_ROBLOX_DIR);
if (localLimitFixed > 0) {
  console.log(`  ✅ Fixed local variable limit in ${localLimitFixed} file(s)`);
} else {
  console.log('  ✨ No files exceeded the local variable limit');
}

// Step 7: Update wrapper files to re-export types (with generics)
console.log('\nStep 7: Updating wrapper files with type exports...');
const wrappersUpdated = updateWrapperTypes();
if (wrappersUpdated > 0) {
  console.log(`\n✅ Updated ${wrappersUpdated} wrapper file(s) with type exports!`);
} else {
  console.log('\n✨ No wrapper files needed type updates');
}

// Step 8: Patch script.Parent references in third-party packages (ReactCharm, ReactRipple)
console.log('\nStep 8: Patching script.Parent references in third-party packages...');
let thirdPartyPatched = 0;

const SCRIPT_PARENT_PATCHES = [
  {
    name: 'ReactCharm',
    dir: REACT_CHARM_DIR,
  },
  {
    name: 'ReactRipple',
    dir: REACT_RIPPLE_DIR,
  },
];

for (const pkg of SCRIPT_PARENT_PATCHES) {
  if (!fs.existsSync(pkg.dir)) {
    console.log(`  ⚠ ${pkg.name}: directory not found, skipping`);
    continue;
  }

  const files = fs.readdirSync(pkg.dir).filter(f => f.endsWith('.luau') || f.endsWith('.lua'));
  for (const file of files) {
    const filePath = path.join(pkg.dir, file);
    let content = fs.readFileSync(filePath, 'utf8');
    const original = content;

    // Replace: `if script.Parent.Parent:FindFirstChild("X") then require("path") else require(script...) :: never`
    // With: just the path-based require
    content = content.replace(
      /local\s+(\w+)\s*=\s*if\s+script\.Parent[\s\S]*?then\s+require\(["']([^"']+)["']\)[\s\S]*?:: never/g,
      (match, varName, requirePath) => {
        return `local ${varName} = require("${requirePath}")`;
      }
    );

    // Also catch any remaining bare `script.Parent` requires
    content = content.replace(
      /require\(\(script\.Parent[^)]*\)\s*::\s*any\)/g,
      '-- (removed script.Parent require, handled by path-based require above)'
    );

    if (content !== original) {
      fs.writeFileSync(filePath, content, 'utf8');
      thirdPartyPatched++;
      console.log(`  ✓ ${pkg.name}: patched ${file}`);
    }
  }
}

if (thirdPartyPatched > 0) {
  console.log(`  ✅ Patched ${thirdPartyPatched} third-party file(s)`);
} else {
  console.log('  ✨ No third-party files needed patching');
}

console.log('\n🎉 React patching complete!');
