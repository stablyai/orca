import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  __getSecureFileHardeningCacheStateForTests,
  __resetSecureFileHardenedPathsForTests,
  hardenExistingSecureFile,
  isUnreadableError,
  writeSecureFile
} from './secure-file'
import {
  setWindowsSecurityForTests,
  resetWindowsSecurityLoadForTests
} from './windows-security-addon'
import { createFakeWindowsSecurity } from './windows-security-addon.test-fixture'

const posixModeIt = process.platform === 'win32' ? it.skip : it

describe('POSIX secure files', () => {
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  const tempDirs: string[] = []

  beforeEach(() => {
    resetWindowsSecurityLoadForTests()
    __resetSecureFileHardenedPathsForTests()
  })

  afterEach(() => {
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

  it('never touches the Windows ACL addon off win32', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    const fake = createFakeWindowsSecurity()
    setWindowsSecurityForTests(fake)
    const targetPath = join(tempDir(), 'secret.json')

    writeSecureFile(targetPath, 'contents')
    hardenExistingSecureFile(targetPath)

    expect(fake.calls).toEqual([])
  })

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

  posixModeIt('LRU-bounds POSIX hardening entries while keeping recent paths cached', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
    __resetSecureFileHardenedPathsForTests({
      maxEntries: 2,
      maxKeyBytes: 4096,
      maxTotalKeyBytes: 8192
    })
    const userDataPath = tempDir()
    const firstPath = join(userDataPath, 'first.json')
    const secondPath = join(userDataPath, 'second.json')
    writeFileSync(firstPath, '{}')
    writeFileSync(secondPath, '{}')

    hardenExistingSecureFile(firstPath)
    hardenExistingSecureFile(secondPath)
    expect(__getSecureFileHardeningCacheStateForTests().paths.paths).toEqual([
      userDataPath,
      secondPath
    ])

    hardenExistingSecureFile(firstPath)
    expect(__getSecureFileHardeningCacheStateForTests().paths.paths).toEqual([
      userDataPath,
      firstPath
    ])
  })
})

function statMode(path: string): number {
  return statSync(path).mode & 0o777
}

describe('isUnreadableError', () => {
  const withCode = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code })

  // The hardened-DACL case this predicate was written for.
  it('reports a denied read', () => {
    expect(isUnreadableError(withCode('EPERM'))).toBe(true)
    expect(isUnreadableError(withCode('EACCES'))).toBe(true)
  })

  /**
   * The likelier half on Windows: antivirus holding a credential open during startup yields
   * EBUSY, and fd exhaustion yields EMFILE. Neither says the bytes were read, so neither may
   * license a regenerate-and-overwrite.
   */
  it('reports a read that never reached the contents for any other reason', () => {
    expect(isUnreadableError(withCode('EBUSY'))).toBe(true)
    expect(isUnreadableError(withCode('EMFILE'))).toBe(true)
    expect(isUnreadableError(withCode('ENFILE'))).toBe(true)
    expect(isUnreadableError(withCode('EIO'))).toBe(true)
  })

  /**
   * The other side of the distinction, and the reason this is an allow list rather than
   * "everything except ENOENT": a missing file licenses creating one, and bytes that were read
   * and did not parse are the self-heal these stores exist to perform.
   */
  it('does not report a missing file or a parse failure', () => {
    expect(isUnreadableError(withCode('ENOENT'))).toBe(false)
    expect(isUnreadableError(new SyntaxError('Unexpected end of JSON input'))).toBe(false)
    expect(isUnreadableError(withCode('EISDIR'))).toBe(false)
    expect(isUnreadableError(undefined)).toBe(false)
  })
})
