import type * as NodeFs from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WINDOWS_RM_MAX_RETRIES, removeTreeSync } from './windows-transient-lock-removal'

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

describe('transient lock removal options', () => {
  const originalPlatform = process.platform

  afterEach(() => {
    Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
    rmSyncMock.mockReset()
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
})
