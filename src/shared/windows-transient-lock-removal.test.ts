import type * as NodeFs from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { scanSourceTree, stripComments } from './source-scan/source-tree-scan'
import {
  WINDOWS_RM_MAX_RETRIES,
  WINDOWS_RM_RETRY_DELAY_MS,
  removeTreeSync,
  transientLockRemovalOptions
} from './windows-transient-lock-removal'

const { rmSyncMock } = vi.hoisted(() => ({
  rmSyncMock: vi.fn()
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  return { ...actual, rmSync: rmSyncMock }
})

function withPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

const SOURCE_ROOT = join(__dirname, '..')
const OWNING_MODULE = 'shared/windows-transient-lock-removal.ts'
/** A `const WINDOWS_RM_… =` line, i.e. a file stating the policy rather than importing it. */
const POLICY_DECLARATION =
  /^\s*(?:export\s+)?const\s+WINDOWS_RM_(?:MAX_RETRIES|RETRY_DELAY_MS)\s*=/m

/** Every file that declares the retry policy instead of importing it. */
function findPolicyDeclarations(): string[] {
  return scanSourceTree(SOURCE_ROOT, { includeTests: true })
    .filter(
      (file) =>
        POLICY_DECLARATION.test(file.source) && POLICY_DECLARATION.test(stripComments(file.source))
    )
    .map((file) => file.relativePath)
    .sort()
}

describe('transient lock removal options', () => {
  const originalPlatform = process.platform

  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    rmSyncMock.mockReset()
  })

  it('retries on Windows, where a late handle release is the whole problem', () => {
    withPlatform('win32')

    expect(transientLockRemovalOptions()).toEqual({
      recursive: true,
      force: true,
      maxRetries: WINDOWS_RM_MAX_RETRIES,
      retryDelay: WINDOWS_RM_RETRY_DELAY_MS
    })
  })

  it('matches the repo policy of eight attempts', () => {
    expect(WINDOWS_RM_MAX_RETRIES).toBe(8)
  })

  it('asks for no retries where removal is not raced by the OS', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      withPlatform(platform)
      expect(transientLockRemovalOptions()).toEqual({ recursive: true, force: true })
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    }
  })

  it('retries a transient EPERM instead of treating force: true as enough', () => {
    withPlatform('win32')
    const eperm = Object.assign(new Error('EPERM: operation not permitted, unlink'), {
      code: 'EPERM'
    })
    rmSyncMock.mockImplementationOnce(() => {
      throw eperm
    })
    rmSyncMock.mockImplementationOnce(() => undefined)

    expect(() => removeTreeSync('C:\\temp\\orca-host-job')).not.toThrow()
    expect(rmSyncMock).toHaveBeenCalledTimes(2)
    expect(rmSyncMock.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ recursive: true, force: true, maxRetries: WINDOWS_RM_MAX_RETRIES })
    )
  })

  it('does not hide a non-lock removal failure', () => {
    withPlatform('win32')
    rmSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' })
    })

    expect(() => removeTreeSync('C:\\temp\\orca-host-job')).toThrow('EIO')
    expect(rmSyncMock).toHaveBeenCalledTimes(1)
  })

  it('actually detects a file that states the policy', () => {
    // Without this the scan below passes for any reason at all, including not scanning.
    expect(POLICY_DECLARATION.test('const WINDOWS_RM_MAX_RETRIES = 8')).toBe(true)
    expect(POLICY_DECLARATION.test('  export const WINDOWS_RM_RETRY_DELAY_MS = 150')).toBe(true)
    // Importing the policy is the thing this rule is asking for, not a violation of it.
    expect(POLICY_DECLARATION.test('import { WINDOWS_RM_MAX_RETRIES } from x')).toBe(false)
    expect(POLICY_DECLARATION.test('    retryDelay: WINDOWS_RM_RETRY_DELAY_MS')).toBe(false)
  })

  it('is the only file that states the policy', () => {
    // Why a ratchet: a second copy is how "8 attempts" becomes 8 in one file and 4 in another,
    // and nothing fails until a Windows lane goes red for a reason nobody can place.
    expect(
      findPolicyDeclarations(),
      'declare the retry policy once, in src/shared/windows-transient-lock-removal.ts, and import it'
    ).toEqual([OWNING_MODULE])
  })
})
