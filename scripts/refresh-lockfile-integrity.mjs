#!/usr/bin/env node
// Refresh lockfile integrity for cohort tarballs to match the actual store
// bytes. The store location defaults to the same place build-cohort-windows.mjs
// derives, and can be overridden with --store or DSH_COHORT_STORE.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const LOCKFILE = join(REPO_ROOT, 'pnpm-lock.yaml')

const { values } = parseArgs({
  options: { 'store': { type: 'string' } },
})
const storeDir = resolve(
  values['store']
  ?? process.env.DSH_COHORT_STORE
  ?? join(REPO_ROOT, '..', '..', '.dsh-cohorts', '0.1.2-alpha.1'),
)
const marker = `file:${storeDir.replace(/\\/g, '/')}/`
let updated = 0

const lines = readFileSync(LOCKFILE, 'utf8').split('\n').map(line => {
  if (!line.includes(marker)) return line
  const m = /tarball: file:[^\s]+\/([^}\s]+\.tgz)/.exec(line)
  if (!m) return line
  const tarball = join(storeDir, m[1])
  if (!existsSync(tarball)) return line
  const hash = `sha512-${createHash('sha512').update(readFileSync(tarball)).digest('base64')}`
  const next = line.replace(/integrity: sha512-[^,}]*/, `integrity: ${hash}`)
  if (next !== line) updated += 1
  return next
})
writeFileSync(LOCKFILE, lines.join('\n'))
console.log(`refresh-integrity: updated ${updated} integrity entries`)
