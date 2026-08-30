#!/usr/bin/env node
/**
 * Windows-safe self-contained cohort tarball builder for dsh-web.
 *
 * Mirrors scripts/build-cohort-tarballs.mjs but packs every referenced
 * @deepseek-ai package directly with `pnpm pack` (the original relies on
 * `pnpm run release:pack`, which is unreliable on Windows), then normalizes
 * peerDependencies into dependencies and refreshes lockfile integrity.
 *
 * The harness checkout and cohort store are configurable so the script works
 * on any machine:
 *   --harness <dir>   official deepseek-harness checkout (required unless
 *                     DSH_HARNESS_DIR is set; the repo auto-detects a sibling
 *                     `deepseek-harness` directory as a fallback)
 *   --store <dir>     cohort tarball store; defaults to the same location the
 *                     upstream builder derives from pnpm-workspace.yaml
 *   --pnpm <cmd>      pnpm command; defaults to `pnpm` on PATH (spawned via
 *                     shell so the Windows .cmd shim resolves)
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const WORKSPACE_FILE = join(REPO_ROOT, 'pnpm-workspace.yaml')

const { values } = parseArgs({
  options: {
    'harness-dir': { type: 'string' },
    'store-dir': { type: 'string' },
    'pnpm': { type: 'string' },
  },
})

function fail(msg) {
  console.error(`build-cohort-windows: ${msg}`)
  process.exit(1)
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { stdio: 'inherit', ...options })
  if (result.status !== 0) fail(`${cmd} ${args.join(' ')} failed with exit code ${result.status}`)
  return true
}

/** pnpm is a shell shim on Windows; spawn it through the shell. */
function runPnpm(args, options = {}) {
  const pnpm = values['pnpm'] ?? process.env.PNPM_CMD ?? 'pnpm'
  return run(pnpm, args, { ...options, shell: process.platform === 'win32' })
}

/** Default harness checkout: explicit flag/env, else a sibling `deepseek-harness`. */
function resolveHarnessDir() {
  const explicit = values['harness-dir'] ?? process.env.DSH_HARNESS_DIR
  if (explicit) return resolve(explicit)
  const sibling = resolve(REPO_ROOT, '..', 'deepseek-harness')
  return existsSync(join(sibling, 'pnpm-workspace.yaml')) ? sibling : undefined
}

function readOverrides() {
  const overrides = {}
  for (const line of readFileSync(WORKSPACE_FILE, 'utf8').split('\n')) {
    const m = /^\s+'(@deepseek-ai\/[^']+)':\s*'file:([^']+)'\s*$/.exec(line)
    if (m) overrides[m[1]] = resolve(REPO_ROOT, m[2])
  }
  return overrides
}

function findPackageDirs(root) {
  const dirs = []
  const skip = new Set(['node_modules', '.git', 'dist', 'coverage', '.turbo'])
  const walk = (dir, depth) => {
    if (depth > 4) return
    if (existsSync(join(dir, 'package.json'))) dirs.push(dir)
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !skip.has(entry.name)) walk(join(dir, entry.name), depth + 1)
    }
  }
  walk(root, 0)
  return dirs
}

/** Merge peerDependencies into dependencies (autoInstallPeers is disabled). */
function normalizePackedManifests(storeDir) {
  for (const entry of readdirSync(storeDir)) {
    if (!entry.endsWith('.tgz')) continue
    const tarball = join(storeDir, entry)
    const work = join(tmpdir(), `dsh-cohort-normalize-${Date.now()}-${entry.replace(/\.tgz$/, '')}`)
    mkdirSync(work, { recursive: true })
    try {
      run('tar', ['-xzf', tarball, '-C', work], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
      const manifestPath = join(work, 'package', 'package.json')
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      const peers = manifest.peerDependencies
      if (!peers || Object.keys(peers).length === 0) continue
      const merged = { ...(manifest.dependencies ?? {}), ...peers }
      manifest.dependencies = Object.fromEntries(Object.entries(merged).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      delete manifest.peerDependencies
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
      run('tar', ['-czf', tarball, '-C', work, 'package'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  }
}

function verifyStore(expected) {
  const missing = []
  for (const [name, tarball] of expected) {
    if (!existsSync(tarball) || statSync(tarball).size === 0) missing.push(`${name} -> ${tarball}`)
  }
  if (missing.length > 0) fail(`store incomplete, ${missing.length} tarball(s) missing:\n  ${missing.slice(0, 10).join('\n  ')}`)
}

function refreshLockfileIntegrity(storeDir, versionDir) {
  // Unify every cohort tarball path in the lockfile to the store location so
  // frozen/non-frozen installs resolve identically (the stock lockfile records
  // a checkout-relative `../../.dsh-cohorts/...` form that does not match an
  // explicitly-remapped store).
  const lockfile = join(REPO_ROOT, 'pnpm-lock.yaml')
  const oldRel = 'file:../../.dsh-cohorts/'
  const oldAbs = 'file:/Users/zcl/.dsh-cohorts/'
  const newPrefix = `file:${storeDir.replace(/\\/g, '/')}/`
  let pathUpdated = 0
  const pathLines = readFileSync(lockfile, 'utf8').split('\n').map(line => {
    if (line.includes(oldRel)) { pathUpdated += line.split(oldRel).length - 1; return line.split(oldRel).join(newPrefix) }
    if (line.includes(oldAbs)) { pathUpdated += line.split(oldAbs).length - 1; return line.split(oldAbs).join(newPrefix) }
    return line
  })
  if (pathUpdated > 0) {
    writeFileSync(lockfile, pathLines.join('\n'))
    console.log(`build-cohort-windows: rewrote ${pathUpdated} cohort path entr${pathUpdated === 1 ? 'y' : 'ies'} to ${newPrefix}`)
  }
  const marker = `.dsh-cohorts/${versionDir}/`
  let updated = 0
  const lines = readFileSync(lockfile, 'utf8').split('\n').map(line => {
    const trimmed = line.trim()
    if (!trimmed.startsWith('resolution:') || !trimmed.includes(marker)) return line
    const name = trimmed.split(marker)[1]?.replace(/\.tgz.*/, '.tgz')
    const tarball = name !== undefined ? join(storeDir, name) : undefined
    if (!tarball || !existsSync(tarball)) return line
    const hash = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`
    const next = line.replace(/integrity: sha512-[^,}]*/, `integrity: ${hash}`)
    if (next !== line) updated += 1
    return next
  })
  if (updated > 0) {
    writeFileSync(lockfile, lines.join('\n'))
    console.log(`build-cohort-windows: refreshed ${updated} lockfile integrity entr${updated === 1 ? 'y' : 'ies'}`)
  }
}

const overrides = readOverrides()
const overridePaths = Object.values(overrides)
const versionDir = basename(dirname(overridePaths[0]))
const storeDir = resolve(
  values['store-dir']
  ?? process.env.DSH_COHORT_STORE
  ?? join(REPO_ROOT, '..', '..', '.dsh-cohorts', versionDir),
)
const expected = new Map(
  Object.entries(overrides).map(([name, path]) => [name, join(storeDir, basename(path))]),
)

const missingBefore = [...expected.values()].filter(p => !existsSync(p) || statSync(p).size === 0).length
if (missingBefore === 0) {
  refreshLockfileIntegrity(storeDir, versionDir)
  console.log(`build-cohort-windows: store complete at ${storeDir} (${expected.size}); nothing to do`)
  process.exit(0)
}
console.log(`build-cohort-windows: ${missingBefore}/${expected.size} tarball(s) missing from ${storeDir}`)

const harnessDir = resolveHarnessDir()
if (harnessDir === undefined) {
  fail('cannot locate the deepseek-harness checkout; pass --harness-dir or set DSH_HARNESS_DIR')
}

// Map package name -> harness workspace dir.
const nameToDir = {}
for (const dir of findPackageDirs(harnessDir)) {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    if (manifest.name) nameToDir[manifest.name] = dir
  } catch { /* skip unreadable side manifests */ }
}

mkdirSync(storeDir, { recursive: true })
const scratch = join(tmpdir(), `dsh-cohort-pack-${Date.now()}`)
mkdirSync(scratch, { recursive: true })

let packed = 0
for (const [name, target] of expected) {
  if (existsSync(target) && statSync(target).size > 0) continue
  const dir = nameToDir[name]
  if (!dir) fail(`cannot locate harness workspace package ${name}`)
  console.log(`packing ${name}`)
  runPnpm(['pack', '--pack-destination', scratch], { cwd: dir })
  const produced = readdirSync(scratch).filter(f => f.endsWith('.tgz') && !existsSync(join(storeDir, f)))
  if (produced.length !== 1) fail(`expected exactly one fresh tarball for ${name}, got ${JSON.stringify(produced)}`)
  const src = join(scratch, produced[0])
  const wantName = basename(target)
  if (produced[0] !== wantName) {
    const renamed = join(scratch, wantName)
    renameSync(src, renamed)
  }
  const finalSrc = join(scratch, wantName)
  try { renameSync(finalSrc, target) } catch (e) {
    if (e.code === 'EXDEV' || e.code === 'EPERM') { copyFileSync(finalSrc, target); rmSync(finalSrc, { force: true }) } else throw e
  }
  packed += 1
}
rmSync(scratch, { recursive: true, force: true })

normalizePackedManifests(storeDir)
verifyStore(expected)
refreshLockfileIntegrity(storeDir, versionDir)
console.log(`build-cohort-windows: store ready at ${storeDir} (${packed} packed, ${expected.size} total)`)
