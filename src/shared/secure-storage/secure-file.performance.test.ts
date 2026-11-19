import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { __resetSecureFileHardenedPathsForTests, hardenExistingSecureFile } from './secure-file'

const posixIt = process.platform === 'win32' ? it.skip : it

// Guards #PR_NUMBER: polling processes each chmodded already-restricted files, bumping ctime and
// invalidating every other process's cache, so userData emitted ~10 file events per second forever.
describe('secure file hardening', () => {
  const dirs: string[] = []

  afterEach(() => {
    __resetSecureFileHardenedPathsForTests()
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  posixIt('leaves an already-restricted file and directory untouched across process caches', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-secure-perf-'))
    dirs.push(dir)
    const file = join(dir, 'store.json')
    writeFileSync(file, '{}', { mode: 0o600 })
    hardenExistingSecureFile(file)
    const fileCtime = statSync(file).ctimeMs
    const dirCtime = statSync(dir).ctimeMs

    for (let reader = 0; reader < 5; reader++) {
      // A fresh cache stands in for another process reading the same store.
      __resetSecureFileHardenedPathsForTests()
      hardenExistingSecureFile(file)
    }

    expect(statSync(file).ctimeMs).toBe(fileCtime)
    expect(statSync(dir).ctimeMs).toBe(dirCtime)
  })
})
