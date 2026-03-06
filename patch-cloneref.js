#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');

const PROJECT_ROOT = path.join(__dirname, '../..');
const PACKAGES_DIR = path.join(PROJECT_ROOT, 'Packages');
const API_CACHE_PATH = path.join(__dirname, '.roblox-api-cache.json');

const API_DUMP_URL = 'https://raw.githubusercontent.com/MaximumADHD/Roblox-Client-Tracker/roblox/Full-API-Dump.json';
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 1 day

console.log('🔧 Patching service access and GetMouse with cloneref...\n');

/**
 * Fetch a URL and return the response body as a string.
 */
function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'patch-cloneref' } }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetch(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Extract service class names from the Roblox Full-API-Dump.
 * A class is a service if it has the "Service" tag.
 */
function extractServices(apiDump) {
  const services = [];
  for (const cls of apiDump.Classes) {
    if (cls.Tags && cls.Tags.includes('Service')) {
      services.push(cls.Name);
    }
  }
  return services.sort();
}

/**
 * Get the list of Roblox services, using a cached copy if fresh enough.
 */
async function getRobloxServices() {
  // Check cache
  if (fs.existsSync(API_CACHE_PATH)) {
    try {
      const cache = JSON.parse(fs.readFileSync(API_CACHE_PATH, 'utf8'));
      const age = Date.now() - cache.lastFetch;
      if (age < CACHE_MAX_AGE_MS && cache.services && cache.services.length > 0) {
        console.log(`  Using cached service list (${cache.services.length} services, ${Math.round(age / 3600000)}h old)`);
        return cache.services;
      }
    } catch {
      // Cache corrupted, re-fetch
    }
  }

  // Fetch fresh API dump
  console.log('  Downloading Roblox API dump...');
  try {
    const body = await fetch(API_DUMP_URL);
    const apiDump = JSON.parse(body);
    const services = extractServices(apiDump);

    // Write cache
    fs.writeFileSync(API_CACHE_PATH, JSON.stringify({ lastFetch: Date.now(), services }, null, 2), 'utf8');
    console.log(`  ✓ Fetched ${services.length} services from API dump\n`);
    return services;
  } catch (err) {
    console.warn(`  ⚠️  Failed to fetch API dump: ${err.message}`);

    // Fall back to stale cache if available
    if (fs.existsSync(API_CACHE_PATH)) {
      try {
        const cache = JSON.parse(fs.readFileSync(API_CACHE_PATH, 'utf8'));
        if (cache.services && cache.services.length > 0) {
          console.log(`  Using stale cache (${cache.services.length} services)`);
          return cache.services;
        }
      } catch {}
    }

    console.error('  ❌ No cached data available and fetch failed. Cannot proceed.');
    process.exit(1);
  }
}

/**
 * Wrap GetService calls, direct service access, and GetMouse calls with cloneref().
 *
 * Processing order matters to avoid double-wrapping:
 *   1. :GetMouse() first (captures largest expressions including GetService chains)
 *   2. game:GetService(...) / game.GetService(game, ...)
 *   3. game.ServiceName (direct property access)
 *
 * Each pattern uses a negative lookbehind (?<!cloneref\() so re-runs are safe.
 */
function wrapWithCloneref(content, servicePattern) {
  let modified = content;
  let changeCount = 0;

  const wrap = (match) => { changeCount++; return `cloneref(${match})`; };

  // ── GetMouse ────────────────────────────────────────────────────────

  // :GetMouse() method call
  // Handles chains like: game:GetService("Players").LocalPlayer:GetMouse()
  //                       player:GetMouse()
  //                       game.Players.LocalPlayer:GetMouse()
  modified = modified.replace(
    /(?<!cloneref\()([\w][\w.]*(?::GetService\([^)]*\))?(?:\.[\w]+)*:GetMouse\(\))/g,
    wrap,
  );

  // .GetMouse(self) functional call style
  modified = modified.replace(
    /(?<!cloneref\()([\w][\w.]*\.GetMouse\([^)]*\))/g,
    wrap,
  );

  // ── GetService ──────────────────────────────────────────────────────

  // game:GetService("ServiceName") — standard method call
  modified = modified.replace(
    /(?<!cloneref\()game:GetService\(["'][^"']+["']\)/g,
    wrap,
  );

  // game.GetService(game, "ServiceName") — functional call style
  modified = modified.replace(
    /(?<!cloneref\()game\.GetService\(game,\s*["'][^"']+["']\)/g,
    wrap,
  );

  // ── Direct service property access ──────────────────────────────────

  // game.Workspace, game.Players, etc. (from API dump)
  modified = modified.replace(
    new RegExp(`(?<!cloneref\\()game\\.(${servicePattern})(?!\\w)`, 'g'),
    wrap,
  );

  // ── Add cloneref polyfill if we made any changes ────────────────────

  if (changeCount > 0 && !modified.includes('local cloneref')) {
    const lines = modified.split('\n');
    let insertIndex = 0;
    // Skip leading comments, pragmas (--!strict), and blank lines
    while (insertIndex < lines.length) {
      const trimmed = lines[insertIndex].trim();
      if (trimmed.startsWith('--') || trimmed === '') {
        insertIndex++;
      } else {
        break;
      }
    }
    lines.splice(insertIndex, 0, 'local cloneref = cloneref or function(o) return o end');
    modified = lines.join('\n');
  }

  return { content: modified, changeCount };
}

function processDirectory(dir, servicePattern) {
  let filesPatched = 0;
  let totalChanges = 0;

  if (!fs.existsSync(dir)) {
    console.warn(`⚠️  Directory not found: ${dir}`);
    return { filesPatched, totalChanges };
  }

  const entries = fs.readdirSync(dir);

  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      const sub = processDirectory(fullPath, servicePattern);
      filesPatched += sub.filesPatched;
      totalChanges += sub.totalChanges;
    } else if (entry.endsWith('.luau') || entry.endsWith('.lua')) {
      const original = fs.readFileSync(fullPath, 'utf8');
      const { content, changeCount } = wrapWithCloneref(original, servicePattern);

      if (content !== original) {
        fs.writeFileSync(fullPath, content, 'utf8');
        filesPatched++;
        totalChanges += changeCount;
        console.log(`  ✓ ${path.relative(PROJECT_ROOT, fullPath)} (${changeCount} wraps)`);
      }
    }
  }

  return { filesPatched, totalChanges };
}

async function main() {
  const services = await getRobloxServices();

  // Escape any regex-special chars in service names (unlikely but safe)
  const servicePattern = services.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');

  const { filesPatched, totalChanges } = processDirectory(PACKAGES_DIR, servicePattern);

  if (filesPatched > 0) {
    console.log(`\n✅ Wrapped ${totalChanges} call(s) with cloneref across ${filesPatched} file(s)`);
  } else {
    console.log('\n✨ No service access or GetMouse calls found to wrap');
  }

  console.log('\n🎉 Cloneref patching complete!');
}

main();
