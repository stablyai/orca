import { chmodSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
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

  it('is true wherever the platform has a real permission model', () => {
    if (process.platform === 'win32') {
      return
    }

    expect(permissionBitsAreEnforced()).toBe(true)
  })

  it('leaves no probe directories behind', () => {
    permissionBitsAreEnforced()

    expect(readdirSync(tmpdir()).filter((n) => n.startsWith('orca-mode-probe-'))).toEqual([])
  })
})
