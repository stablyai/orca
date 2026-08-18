import type { Stats } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { isConfirmedCursorPathMissing } from './cursor-sidecar-path-presence'

const missing = Object.assign(new Error('missing'), { code: 'ENOENT' })

describe('Cursor sidecar path presence', () => {
  it('accepts ordinary missing paths without ancestor probes', async () => {
    const lstat = vi.fn()

    await expect(isConfirmedCursorPathMissing('/home/ada/missing', missing, lstat)).resolves.toBe(
      true
    )
    expect(lstat).not.toHaveBeenCalled()
  })

  it('confirms a missing WSL path through its nearest reachable ancestor', async () => {
    const lstat = vi
      .fn()
      .mockRejectedValueOnce(missing)
      .mockResolvedValueOnce({} as Stats)

    await expect(
      isConfirmedCursorPathMissing(
        '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.cursor\\chats',
        missing,
        lstat
      )
    ).resolves.toBe(true)
    expect(lstat).toHaveBeenNthCalledWith(1, '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.cursor')
    expect(lstat).toHaveBeenNthCalledWith(2, '\\\\wsl.localhost\\Ubuntu\\home\\ada')
  })

  it('does not call an unreachable WSL share missing', async () => {
    const lstat = vi.fn().mockRejectedValue(missing)

    await expect(
      isConfirmedCursorPathMissing(
        '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.cursor\\chats',
        missing,
        lstat
      )
    ).resolves.toBe(false)
    expect(lstat).toHaveBeenCalledWith('\\\\wsl.localhost\\Ubuntu\\')
  })

  it('does not call an unreachable ordinary UNC share missing', async () => {
    const lstat = vi.fn().mockRejectedValue(missing)

    await expect(
      isConfirmedCursorPathMissing('\\\\server\\cursor-data\\chats\\bucket', missing, lstat)
    ).resolves.toBe(false)
    expect(lstat).toHaveBeenCalledWith('\\\\server\\cursor-data\\')
  })

  it('does not turn a cancelled ancestor probe into missing history', async () => {
    const cancelled = new Error('cursor_sidecar_scan_cancelled')

    await expect(
      isConfirmedCursorPathMissing(
        '\\\\wsl.localhost\\Ubuntu\\home\\ada\\.cursor\\chats',
        missing,
        async () => {
          throw cancelled
        }
      )
    ).rejects.toBe(cancelled)
  })
})
