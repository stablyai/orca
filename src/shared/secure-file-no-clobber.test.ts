import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import type * as NodeFs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeSecureFileNoClobber } from './secure-file'
import {
  resetWindowsSecurityLoadForTests,
  setWindowsSecurityForTests
} from './windows-security-addon'
import { createFakeWindowsSecurity } from './windows-security-addon.test-fixture'

const linkFailure = vi.hoisted((): { code: string | null } => ({ code: null }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return {
    ...actual,
    linkSync: (...args: Parameters<typeof actual.linkSync>) => {
      if (linkFailure.code) {
        throw Object.assign(new Error(linkFailure.code), { code: linkFailure.code })
      }
      actual.linkSync(...args)
    }
  }
})

const dirs: string[] = []
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orca-observer-bearer-test-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  linkFailure.code = null
  resetWindowsSecurityLoadForTests()
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('observer bearer no-clobber publication', () => {
  it('publishes a fictional bearer with restricted POSIX mode and keeps an existing output intact', () => {
    const dir = tempDir()
    const target = join(dir, 'bearer.txt')
    expect(writeSecureFileNoClobber(target, 'fictional-bearer')).toBe(true)
    expect(readFileSync(target, 'utf8')).toBe('fictional-bearer')
    expect(statSync(target).mode & 0o777).toBe(0o600)
    expect(() => writeSecureFileNoClobber(target, 'replacement')).toThrow()
    expect(readFileSync(target, 'utf8')).toBe('fictional-bearer')
    expect(readdirSync(dir)).toEqual(['bearer.txt'])
  })

  it('refuses to publish or stage output when the Windows ACL addon is unavailable', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    setWindowsSecurityForTests(null)
    const dir = tempDir()
    const target = join(dir, 'bearer.txt')
    expect(() => writeSecureFileNoClobber(target, 'fictional-bearer')).toThrow(
      'Bearer output could not be secured'
    )
    expect(existsSync(target)).toBe(false)
    expect(readdirSync(dir)).toEqual([])
  })

  it('uses restricted Windows staging and refuses to replace a competing output', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const fake = createFakeWindowsSecurity()
    setWindowsSecurityForTests(fake)
    const dir = tempDir()
    const target = join(dir, 'bearer.txt')
    writeFileSync(target, 'competing output')
    expect(() => writeSecureFileNoClobber(target, 'fictional-bearer')).toThrow()
    expect(readFileSync(target, 'utf8')).toBe('competing output')
    const fresh = join(dir, 'fresh.txt')
    expect(writeSecureFileNoClobber(fresh, 'fictional-bearer')).toBe(true)
    expect(readFileSync(fresh, 'utf8')).toBe('fictional-bearer')
    expect(fake.callsFor('create').length).toBeGreaterThanOrEqual(2)
    expect(fake.callsFor('get', fresh).length).toBeGreaterThan(0)
    expect(readdirSync(dir).sort()).toEqual(['bearer.txt', 'fresh.txt'])
  })
})

describe('observer bearer publication failures', () => {
  it('fails closed when the filesystem denies hard-link publication', () => {
    const dir = tempDir()
    const target = join(dir, 'bearer.txt')
    linkFailure.code = 'EPERM'
    expect(() => writeSecureFileNoClobber(target, 'fictional-bearer')).toThrow('EPERM')
    expect(existsSync(target)).toBe(false)
    expect(readdirSync(dir)).toEqual([])
  })

  it('removes its own published link if the final Windows target ACL cannot be verified', () => {
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    const fake = createFakeWindowsSecurity()
    setWindowsSecurityForTests(fake)
    const dir = tempDir()
    const target = join(dir, 'bearer.txt')
    fake.failing.add(target)
    expect(() => writeSecureFileNoClobber(target, 'fictional-bearer')).toThrow(
      'Bearer output could not be secured'
    )
    expect(fake.callsFor('get', target).length).toBeGreaterThan(0)
    expect(existsSync(target)).toBe(false)
    expect(readdirSync(dir)).toEqual([])
  })
})
