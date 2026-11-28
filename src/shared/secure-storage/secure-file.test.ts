import * as fs from 'node:fs'
import {
  chmodSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetSecureFileHardenedPathsForTests,
  hardenExistingSecureFile,
  writeSecureFile
} from './secure-file'

const posixModeIt = process.platform === 'win32' ? it.skip : it
const describeOnWindows = process.platform === 'win32' ? describe : describe.skip

describe('POSIX secure files', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  const tempDirs: string[] = []

  beforeEach(() => {
    __resetSecureFileHardenedPathsForTests()
  })

  afterEach(() => {
    __resetSecureFileHardenedPathsForTests()
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
})

function statMode(path: string): number {
  return statSync(path).mode & 0o777
}

describeOnWindows('Windows secure file publish', () => {
  it('retries a locked rename and publishes nothing once shouldPublish refuses', () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-secure-file-'))
    const targetPath = join(userDataPath, 'secret.json')
    const renameSync = vi.spyOn(fs, 'renameSync')
    const locked = () => {
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
    }
    try {
      writeSecureFile(targetPath, 'old')
      // A scanner holding the staged file releases it before the next attempt.
      renameSync.mockImplementationOnce(locked)
      writeSecureFile(targetPath, 'new')
      expect(readFileSync(targetPath, 'utf8')).toBe('new')

      renameSync.mockImplementationOnce(locked)
      let checks = 0
      expect(
        writeSecureFile(targetPath, 'later', {
          shouldPublish: () => (checks += 1) === 1
        })
      ).toBe(false)
      expect(checks).toBe(2)
      expect(readFileSync(targetPath, 'utf8')).toBe('new')
      expect(readdirSync(userDataPath).filter((name) => name.endsWith('.tmp'))).toEqual([])
    } finally {
      renameSync.mockRestore()
      rmSync(userDataPath, { recursive: true, force: true })
    }
  })
})
