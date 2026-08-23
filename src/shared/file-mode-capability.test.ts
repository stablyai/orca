import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type * as NodeFs from 'node:fs'
import { permissionBitsAreEnforced } from './file-mode-capability'

const created: string[] = []

afterAll(() => {
  for (const directory of created) {
    rmSync(directory, { recursive: true, force: true })
  }
})

/** What this host really does with a mode, decided by doing it. */
function modeSticks(): boolean {
  const directory = mkdtempSync(join(tmpdir(), 'orca-mode-check-'))
  created.push(directory)
  const file = join(directory, 'secret')
  writeFileSync(file, 'x')
  chmodSync(file, 0o600)
  return (statSync(file).mode & 0o777) === 0o600
}

describe('permissionBitsAreEnforced', () => {
  it('reports what this host does with a mode, not what its platform usually does', () => {
    expect(permissionBitsAreEnforced()).toBe(modeSticks())
  })

  it('answers the same way every time, so a suite cannot half-skip', () => {
    expect(permissionBitsAreEnforced()).toBe(permissionBitsAreEnforced())
  })

  it.skipIf(process.platform === 'win32')(
    'is true wherever the platform has a real permission model',
    () => {
      expect(permissionBitsAreEnforced()).toBe(true)
    }
  )

  it('leaves no probe directories behind', () => {
    permissionBitsAreEnforced()

    expect(readdirSync(tmpdir()).filter((n) => n.startsWith('orca-mode-probe-'))).toEqual([])
  })
})

describe('permissionBitsAreEnforced when the scratch directory will not delete', () => {
  const leaked: string[] = []

  afterEach(() => {
    vi.doUnmock('node:fs')
    vi.resetModules()
    // The probe's own cleanup was mocked away, so it is this suite's job.
    for (const directory of leaked.splice(0)) {
      rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
    }
  })

  it('still answers, because a throw here fails test-file collection outright', async () => {
    vi.resetModules()
    const real = await vi.importActual<typeof NodeFs>('node:fs')
    vi.doMock('node:fs', () => {
      const mocked = {
        ...real,
        mkdtempSync: (prefix: string) => {
          const directory = real.mkdtempSync(prefix)
          leaked.push(directory)
          return directory
        },
        rmSync: () => {
          throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
        }
      }
      return { ...mocked, default: mocked }
    })
    const module = await import('./file-mode-capability')

    expect(() => module.permissionBitsAreEnforced()).not.toThrow()
    expect(typeof module.permissionBitsAreEnforced()).toBe('boolean')
  })
})
