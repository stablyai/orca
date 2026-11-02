import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetSecureFileHardenedPathsForTests,
  hardenExistingSecureFile,
  writeSecureFile
} from './secure-file'
import {
  setWindowsSecurityForTests,
  resetWindowsSecurityLoadForTests
} from './windows-security-addon'

const chmodFailure = vi.hoisted((): { code: string | null } => ({ code: null }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    chmodSync: (...args: Parameters<typeof actual.chmodSync>) => {
      if (chmodFailure.code) {
        throw Object.assign(new Error(chmodFailure.code), { code: chmodFailure.code })
      }
      actual.chmodSync(...args)
    }
  }
})

const posixModeIt = process.platform === 'win32' ? it.skip : it

describe('POSIX secure files', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  const tempDirs: string[] = []

  beforeEach(() => {
    resetWindowsSecurityLoadForTests()
    __resetSecureFileHardenedPathsForTests()
  })

  afterEach(() => {
    chmodFailure.code = null
    resetWindowsSecurityLoadForTests()
    __resetSecureFileHardenedPathsForTests()
    setWindowsSecurityForTests(null)
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'orca-secure-file-'))
    tempDirs.push(dir)
    return dir
  }

  posixModeIt('restricts the published file and its directory by mode', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    const userDataPath = tempDir()
    const targetPath = join(userDataPath, 'secret.json')

    expect(writeSecureFile(targetPath, 'contents')).toBe(true)

    expect(statMode(targetPath)).toBe(0o600)
    expect(statMode(userDataPath)).toBe(0o700)
  })

  posixModeIt('re-hardens a POSIX directory when its metadata changes after caching', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    const userDataPath = tempDir()
    const targetPath = join(userDataPath, 'secret.json')
    writeFileSync(targetPath, '{}')

    hardenExistingSecureFile(targetPath)
    expect(statMode(userDataPath)).toBe(0o700)

    chmodSync(userDataPath, 0o755)
    hardenExistingSecureFile(targetPath)

    expect(statMode(userDataPath)).toBe(0o700)
  })

  /** Claude Code's Bash sandbox denies chmod on userData; `orca worktree list` failed reading it (#20937). */
  posixModeIt(
    'lets readers proceed when a sandbox denies hardening, but not on other errors',
    () => {
      Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
      const targetPath = join(tempDir(), 'secret.json')
      writeFileSync(targetPath, '{}')

      chmodFailure.code = 'EPERM'
      expect(() => hardenExistingSecureFile(targetPath)).not.toThrow()

      chmodFailure.code = 'EIO'
      expect(() => hardenExistingSecureFile(targetPath)).toThrow('EIO')
    }
  )
})

function statMode(path: string): number {
  return statSync(path).mode & 0o777
}
