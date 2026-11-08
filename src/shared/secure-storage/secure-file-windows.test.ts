import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { __resetSecureFileHardenedPathsForTests, writeSecureFile } from './secure-file'

import {
  resetWindowsSecurityLoadForTests,
  setWindowsSecurityForTests
} from '../windows-security-addon'
import {
  createFakeWindowsSecurity,
  type FakeWindowsSecurity
} from '../windows-security-addon.test-fixture'

describe('Windows secure files through the native ACL addon', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  const tempDirs: string[] = []
  let fake: FakeWindowsSecurity

  beforeEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    resetWindowsSecurityLoadForTests()
    __resetSecureFileHardenedPathsForTests()
    fake = createFakeWindowsSecurity()
    setWindowsSecurityForTests(fake)
  })

  afterEach(() => {
    setWindowsSecurityForTests(null)
    resetWindowsSecurityLoadForTests()
    __resetSecureFileHardenedPathsForTests()
    if (originalPlatform) {
      Object.defineProperty(process, 'platform', originalPlatform)
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'orca-secure-file-win-'))
    tempDirs.push(dir)
    return dir
  }

  describe('write path', () => {
    it('throws a failed restricted create and leaves no temp file', () => {
      const dir = tempDir()
      const targetPath = join(dir, 'secret.json')
      writeFileSync(targetPath, 'previous')
      fake.createFileWithDacl = () => {
        throw new Error('CreateFileW failed with Win32 error 5')
      }

      expect(() => writeSecureFile(targetPath, 'contents')).toThrow(
        'CreateFileW failed with Win32 error 5'
      )

      expect(readFileSync(targetPath, 'utf-8')).toBe('previous')
      expect(readdirSync(dir).filter((name) => name.endsWith('.tmp'))).toEqual([])
    })
  })
})
