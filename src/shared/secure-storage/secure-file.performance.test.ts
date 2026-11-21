import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFs from 'node:fs'
import type * as SecureFile from './secure-file'

const chmods = vi.hoisted(() => ({ count: 0 }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  const countedChmodSync: typeof actual.chmodSync = (...args) => {
    chmods.count += 1
    return actual.chmodSync(...args)
  }
  return {
    ...actual,
    default: { ...actual, chmodSync: countedChmodSync },
    chmodSync: countedChmodSync
  }
})

const posixIt = process.platform === 'win32' ? it.skip : it

/** A fresh module instance has an empty hardening cache, like another process reading the same store. */
async function readerProcess(): Promise<typeof SecureFile> {
  vi.resetModules()
  return import('./secure-file')
}

// Guards #44839: polling processes each chmodded already-restricted files, bumping ctime and
// invalidating every other process's cache, so userData emitted ~10 file events per second forever.
describe('secure file hardening', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function restrictedStore(): string {
    const dir = mkdtempSync(join(tmpdir(), 'orca-secure-perf-'))
    dirs.push(dir)
    chmodSync(dir, 0o700)
    const file = join(dir, 'store.json')
    writeFileSync(file, '{}', { mode: 0o600 })
    chmodSync(file, 0o600)
    return file
  }

  posixIt('five readers of an already-restricted store chmod nothing', async () => {
    const file = restrictedStore()
    chmods.count = 0

    for (let reader = 0; reader < 5; reader++) {
      ;(await readerProcess()).hardenExistingSecureFile(file)
    }

    expect(chmods.count).toBe(0)
  })

  posixIt('a reader still restricts a store whose mode drifted', async () => {
    const file = restrictedStore()
    chmodSync(file, 0o644)
    chmods.count = 0

    ;(await readerProcess()).hardenExistingSecureFile(file)

    expect(chmods.count).toBe(1)
    expect(statSync(file).mode & 0o7777).toBe(0o600)
  })
})
