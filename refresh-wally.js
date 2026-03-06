#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PROJECT_ROOT = path.join(__dirname, '../..');
const PACKAGES_DIR = path.join(PROJECT_ROOT, 'Packages');
const INDEX_DIR_OLD = path.join(PACKAGES_DIR, '_Index');
const INDEX_DIR_NEW = path.join(PACKAGES_DIR, 'index');
const LUAURC_PATH = path.join(PROJECT_ROOT, '.luaurc');

console.log('🔄 Starting Wally refresh...\n');

// Step 1: Run wally install
console.log('📦 Running wally install...');
try {
  execSync('wally install', { stdio: 'inherit', cwd: PROJECT_ROOT });
  console.log('✅ wally install completed\n');
} catch (error) {
  console.error('❌ wally install failed:', error.message);
  process.exit(1);
}

// Step 2: Rename _Index to index
console.log('📁 Renaming _Index to index...');
try {
  // Remove old index folder if it exists
  if (fs.existsSync(INDEX_DIR_NEW)) {
    fs.rmSync(INDEX_DIR_NEW, { recursive: true, force: true });
  }

  // Rename _Index to index
  if (fs.existsSync(INDEX_DIR_OLD)) {
    fs.renameSync(INDEX_DIR_OLD, INDEX_DIR_NEW);
    console.log('✅ Renamed _Index to index\n');
  } else {
    console.warn('⚠️  _Index folder not found, skipping rename\n');
  }
} catch (error) {
  console.error('❌ Failed to rename _Index folder:', error.message);
  process.exit(1);
}

// Step 3: Replace all require statements
console.log('🔍 Converting require statements...');

function convertRequireStatement(content, filePath) {
  let modified = content;

  // Handle @self/ notation (Wally's self-reference) - convert to ./
  modified = modified.replace(/require\("@self\/([^"]+)"\)/g, (_match, modulePath) => {
    return `require("./${modulePath}")`;
  });

  // Pre-process: Resolve script variable aliases
  // e.g., local Sift = script.Parent.Parent → inline Sift.X into script.Parent.Parent.X
  const scriptAliasPattern = /^local\s+(\w+)\s*=\s*(script(?:\.Parent)+)\s*$/gm;
  let aliasMatch;
  const aliases = [];
  while ((aliasMatch = scriptAliasPattern.exec(modified)) !== null) {
    aliases.push({
      varName: aliasMatch[1],
      scriptPath: aliasMatch[2],
      fullMatch: aliasMatch[0],
    });
  }

  for (const alias of aliases) {
    // Remove the variable assignment line
    modified = modified.replace(alias.fullMatch + '\n', '');
    // Replace require(VAR.X.Y) with require(scriptPath.X.Y)
    modified = modified.replace(
      new RegExp(`require\\(${alias.varName}((?:\\.[a-zA-Z0-9_]+)+)\\)`, 'g'),
      (_match, dotPath) => `require(${alias.scriptPath}${dotPath})`,
    );
  }

  // Pre-process: Normalize multi-line script requires into single-line
  // e.g., require(\n\tscript.Parent.Foo\n) → require(script.Parent.Foo)
  // e.g., require(\n\tscript.Parent["Foo.new"]\n) → require(script.Parent["Foo.new"])
  modified = modified.replace(/require\(\s*\n\s*(script(?:\.Parent)*(?:(?:\.\w+)+|\["[^"]+"\]))\s*\n\s*\)/g,
    (_match, scriptRef) => `require(${scriptRef})`,
  );

  // Helper: Find the _init file for a package/module by searching the directory
  const findModuleInit = (packageName, moduleName) => {
    const basePath = path.join(INDEX_DIR_NEW, packageName, moduleName);

    // Check common locations first (in priority order) - using _init instead of init
    const commonPaths = ['src/_init', 'lib/_init', '_init'];
    for (const commonPath of commonPaths) {
      const fullPath = path.join(basePath, commonPath);
      if (fs.existsSync(fullPath + '.lua') || fs.existsSync(fullPath + '.luau')) {
        return commonPath;
      }
    }

    // If not found in common locations, search recursively
    const searchForInit = (dir, relativePath = '') => {
      if (fs.existsSync(path.join(dir, '_init.lua')) || fs.existsSync(path.join(dir, '_init.luau'))) {
        return relativePath ? `${relativePath}/_init` : '_init';
      }

      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.isDirectory()) {
            const subPath = path.join(dir, entry.name);
            const newRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name;
            const result = searchForInit(subPath, newRelative);
            if (result) return result;
          }
        }
      } catch (e) {
        // Directory doesn't exist or can't be read
      }

      return null;
    };

    return searchForInit(basePath) || '_init';
  };

  // Pattern 1: require(script.Parent._Index["package_name"]["module_name"])
  // For files outside index directory - convert to relative path to index
  const pattern1 = /require\(script\.Parent\._Index\["([^"]+)"\]\["([^"]+)"\]\)/g;
  modified = modified.replace(pattern1, (_match, packageName, moduleName) => {
    const initPath = findModuleInit(packageName, moduleName);
    return `require("./index/${packageName}/${moduleName}/${initPath}")`;
  });

  // Pattern 2: require(script.Parent.Parent["package"]["module"]) with bracket notation
  // For files inside index directory referencing other packages
  modified = modified.replace(/require\(script((?:\.Parent)+)\["([^"]+)"\]\["([^"]+)"\]\)/g, (_match, parents, packageName, moduleName) => {
    const parentCount = (parents.match(/\.Parent/g) || []).length;
    const relativePath = '../'.repeat(parentCount - 1);
    const initPath = findModuleInit(packageName, moduleName);
    return `require("${relativePath}${packageName}/${moduleName}/${initPath}")`;
  });

  // Only process script patterns for files inside the index directory
  if (filePath.includes(path.sep + 'index' + path.sep)) {
    const indexPos = filePath.indexOf(path.sep + 'index' + path.sep);
    if (indexPos !== -1) {
      const afterIndex = filePath.substring(indexPos + path.sep.length + 'index'.length + path.sep.length);
      const pathParts = afterIndex.split(path.sep);

      const packageName = pathParts[0];
      const moduleName = pathParts[1];
      const fileDir = pathParts.slice(2, -1);

      // Check if current file is an init file (affects script.Parent semantics)
      // For init files: script = the folder (ModuleScript), script.Parent = parent folder
      // For other files: script = the file itself, script.Parent = the folder
      const fileName = path.basename(filePath, path.extname(filePath));
      const isInitFile = fileName === 'init';

      // Helper: Check if wrapper file exists at package root
      const checkWrapperFile = (name) => {
        const packageRootDir = path.join(INDEX_DIR_NEW, packageName);
        return fs.existsSync(path.join(packageRootDir, `${name}.lua`)) ||
               fs.existsSync(path.join(packageRootDir, `${name}.luau`));
      };

      // Helper: Build relative path from current file to target
      const buildRelativePath = (targetDir, targetPath) => {
        // Both init files and regular files resolve from the same directory
        const baseDir = fileDir;
        const levelsUp = baseDir.length - targetDir.length;

        if (levelsUp > 0) {
          // Going up directories
          return `${'../'.repeat(levelsUp)}${targetPath}`;
        } else if (levelsUp < 0) {
          // Going down into subdirectories
          const pathDown = targetDir.slice(baseDir.length);
          return `./${pathDown.join('/')}/${targetPath}`;
        } else {
          // Same level - use ./ prefix for both init and regular files
          return `./${targetPath}`;
        }
      };

      // Pattern 3: require(script.WaitForChild(...))
      modified = modified.replace(/require\(script\.WaitForChild\([^)]+\)(?::WaitForChild\([^)]+\))*\)/g, (match) => {
        const modules = [];
        const waitForChildMatches = match.match(/WaitForChild\([^)]+\)/g);
        if (waitForChildMatches) {
          for (const wfc of waitForChildMatches) {
            const nameMatch = wfc.match(/['"]([^'"]+)['"]/);
            if (nameMatch) modules.push(nameMatch[1]);
          }
        }

        if (modules.length === 1 && checkWrapperFile(modules[0])) {
          const levelsUp = fileDir.length + 1;
          return `require("${'../'.repeat(levelsUp)}${modules[0]}")`;
        }

        let modulePath = modules.join('/');
        if (modules.length === 1) {
          const targetDirPath = path.join(INDEX_DIR_NEW, packageName, moduleName, ...fileDir);
          const moduleDirPath = path.join(targetDirPath, modules[0]);
          if (fs.existsSync(moduleDirPath) && fs.statSync(moduleDirPath).isDirectory()) {
            const hasInit = fs.existsSync(path.join(moduleDirPath, 'init.lua')) ||
                          fs.existsSync(path.join(moduleDirPath, 'init.luau'));
            if (hasInit) modulePath = `${modules[0]}/init`;
          }
        }

        // Use fileDir as the target directory for relative path calculation
        return `require("${buildRelativePath(fileDir, modulePath)}")`;
      });

      // Pattern 4: require(script.Parent.Parent...:WaitForChild(...))
      modified = modified.replace(/require\(script(?:\.Parent)+:WaitForChild\([^)]+\)(?::WaitForChild\([^)]+\))*\)/g, (match) => {
        const parentCount = (match.match(/\.Parent/g) || []).length;
        const modules = [];
        const waitForChildMatches = match.match(/WaitForChild\([^)]+\)/g);
        if (waitForChildMatches) {
          for (const wfc of waitForChildMatches) {
            const nameMatch = wfc.match(/['"]([^'"]+)['"]/);
            if (nameMatch) modules.push(nameMatch[1]);
          }
        }

        if (modules.length === 1 && checkWrapperFile(modules[0])) {
          const levelsUp = fileDir.length + 1;
          return `require("${'../'.repeat(levelsUp)}${modules[0]}")`;
        }

        // For init files, script.Parent goes to parent folder; for regular files, it stays in same folder
        // So init files need to go up parentCount levels, while regular files go up (parentCount - 1)
        const targetDir = fileDir.slice(0, fileDir.length - (isInitFile ? parentCount : (parentCount - 1)));
        let modulePath = modules.join('/');

        if (modules.length === 1) {
          const targetDirPath = path.join(INDEX_DIR_NEW, packageName, moduleName, ...targetDir);
          const moduleDirPath = path.join(targetDirPath, modules[0]);
          if (fs.existsSync(moduleDirPath) && fs.statSync(moduleDirPath).isDirectory()) {
            const hasInit = fs.existsSync(path.join(moduleDirPath, 'init.lua')) ||
                          fs.existsSync(path.join(moduleDirPath, 'init.luau'));
            if (hasInit) modulePath = `${modules[0]}/init`;
          }
        }

        return `require("${buildRelativePath(targetDir, modulePath)}")`;
      });

      // Pattern 5: require(script:WaitForChild(...))
      modified = modified.replace(/require\(script:WaitForChild\([^)]+\)(?::WaitForChild\([^)]+\))*\)/g, (match) => {
        const modules = [];
        const waitForChildMatches = match.match(/WaitForChild\([^)]+\)/g);
        if (waitForChildMatches) {
          for (const wfc of waitForChildMatches) {
            const nameMatch = wfc.match(/['"]([^'"]+)['"]/);
            if (nameMatch) modules.push(nameMatch[1]);
          }
        }

        if (modules.length === 1 && checkWrapperFile(modules[0])) {
          const levelsUp = fileDir.length + 1;
          return `require("${'../'.repeat(levelsUp)}${modules[0]}")`;
        }

        let modulePath = modules.join('/');
        if (modules.length === 1) {
          const targetDirPath = path.join(INDEX_DIR_NEW, packageName, moduleName, ...fileDir);
          const moduleDirPath = path.join(targetDirPath, modules[0]);
          if (fs.existsSync(moduleDirPath) && fs.statSync(moduleDirPath).isDirectory()) {
            const hasInit = fs.existsSync(path.join(moduleDirPath, 'init.lua')) ||
                          fs.existsSync(path.join(moduleDirPath, 'init.luau'));
            if (hasInit) modulePath = `${modules[0]}/init`;
          }
        }

        // Use fileDir as the target directory for relative path calculation
        return `require("${buildRelativePath(fileDir, modulePath)}")`;
      });

      // Pattern 6: require(script.X) or require(script.X.Y.Z) - dot notation (multi-level)
      modified = modified.replace(/require\(script\.((?:Parent\.)*(?:[a-zA-Z0-9_-]+\.)*[a-zA-Z0-9_-]+)\)/g, (_match, scriptPath) => {
        const parts = scriptPath.split('.');
        let parentCount = 0;
        while (parts[parentCount] === 'Parent') parentCount++;
        const refParts = parts.slice(parentCount); // e.g. ['Set', 'toArray'] or ['None']

        // For single-segment refs, check if it's a wrapper file at the package root
        if (refParts.length === 1 && checkWrapperFile(refParts[0])) {
          const levelsUp = fileDir.length + 1;
          return `require("${'../'.repeat(levelsUp)}${refParts[0]}")`;
        }

        const targetDir = fileDir.slice(0, fileDir.length - Math.max(0, isInitFile ? parentCount : (parentCount - 1)));
        const targetDirPath = path.join(INDEX_DIR_NEW, packageName, moduleName, ...targetDir);

        // Multi-segment: convert dots to path separators (e.g. Set.toArray -> Set/toArray)
        if (refParts.length > 1) {
          const modulePath = refParts.join('/');
          return `require("${buildRelativePath(targetDir, modulePath)}")`;
        }

        // Single-segment: existing logic for directories and file resolution
        const finalRef = refParts[0];
        let actualFileName = finalRef;

        const moduleDirPath = path.join(targetDirPath, finalRef);
        if (fs.existsSync(moduleDirPath) && fs.statSync(moduleDirPath).isDirectory()) {
          const hasInit = fs.existsSync(path.join(moduleDirPath, 'init.lua')) ||
                        fs.existsSync(path.join(moduleDirPath, 'init.luau'));
          if (hasInit) {
            return `require("${buildRelativePath(targetDir, `${finalRef}/init`)}")`;
          }
        }

        const tryFiles = [
          `${finalRef}.lua`, `${finalRef}.luau`,
          `from${finalRef}.lua`, `from${finalRef}.luau`,
          `${finalRef.toLowerCase()}.lua`, `${finalRef.toLowerCase()}.luau`,
        ];

        for (const tryFile of tryFiles) {
          if (fs.existsSync(path.join(targetDirPath, tryFile))) {
            actualFileName = tryFile.replace(/\.(lua|luau)$/, '');
            break;
          }
        }

        return `require("${buildRelativePath(targetDir, actualFileName)}")`;
      });

      // Pattern 6b: require(script.Parent["name.with.dots"]) - bracket notation
      // Handles filenames with dots that can't use dot notation (e.g. "ReactFiberHotReloading.new")
      modified = modified.replace(/require\(script\.((?:Parent\.)*Parent)\["([^"]+)"\]\)/g, (_match, parents, bracketName) => {
        const parts = parents.split('.');
        const parentCount = parts.length;

        const targetDir = fileDir.slice(0, fileDir.length - Math.max(0, isInitFile ? parentCount : (parentCount - 1)));
        return `require("${buildRelativePath(targetDir, bracketName)}")`;
      });

      // Pattern 7: require("relative/path")
      modified = modified.replace(/require\("([^@][^"]+)"\)/g, (match, requirePath) => {
        if (requirePath.startsWith('@') || requirePath.includes('..') || requirePath.startsWith('./')) {
          return match;
        }

        if (!requirePath.includes('/') && checkWrapperFile(requirePath)) {
          const levelsUp = fileDir.length + 1;
          return `require("${'../'.repeat(levelsUp)}${requirePath}")`;
        }

        return `require("./${requirePath}")`;
      });
    }
  }

  return modified;
}

function reloadLanguageServer() {
  console.log('🔄 Triggering language server reload...');
  try {
    const luaurcContent = fs.readFileSync(LUAURC_PATH, 'utf8');
    fs.writeFileSync(LUAURC_PATH, luaurcContent);
    console.log('✅ Language server reload triggered (modified .luaurc)\n');
  } catch (error) {
    console.warn('⚠️  Could not trigger language server reload:', error.message);
    console.log('   You may need to manually reload the language server\n');
  }
}

function processLuaFile(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const newContent = convertRequireStatement(content, filePath);

    if (content !== newContent) {
      fs.writeFileSync(filePath, newContent, 'utf8');
      console.log(`  ✓ ${path.relative(PROJECT_ROOT, filePath)}`);
      return true;
    }
    return false;
  } catch (error) {
    console.error(`  ✗ Error processing ${filePath}:`, error.message);
    return false;
  }
}

function processDirectory(dir) {
  let filesChanged = 0;
  const files = fs.readdirSync(dir);

  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      filesChanged += processDirectory(filePath);
    } else if (file.endsWith('.lua') || file.endsWith('.luau')) {
      if (processLuaFile(filePath)) {
        filesChanged++;
      }
    }
  }

  return filesChanged;
}

const filesChanged = processDirectory(PACKAGES_DIR);

if (filesChanged > 0) {
  console.log(`\n✅ Converted ${filesChanged} file(s) successfully!`);
} else {
  console.log('\n✨ No files needed conversion (already up to date)');
}

reloadLanguageServer();

console.log('\n🎉 Wally refresh complete!');
console.log('\nNote: The language server should reload automatically.');
console.log('If not, you can manually reload it in VSCode with:');
console.log('  • Ctrl+Shift+P → "Luau: Restart Language Server"');
console.log('  • Or reload the VSCode window');
