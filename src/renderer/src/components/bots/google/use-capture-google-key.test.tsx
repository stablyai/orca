// @vitest-environment happy-dom
import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type KeySource, useCaptureClientKey } from './use-capture-google-key'

const mocks = vi.hoisted(() => ({
  watch: vi.fn(),
  stop: vi.fn()
}))
const DOWNLOADS: KeySource = { kind: 'downloads' }

beforeEach(() => {
  mocks.watch.mockReset()
  mocks.stop.mockReset().mockResolvedValue(undefined)
  Object.assign(window, {
    api: {
      googleSetup: {
        watchDownloads: mocks.watch,
        stopWatchingDownloads: mocks.stop
      }
    }
  })
})

describe('taking the key from Downloads', () => {
  it('stops waiting when Downloads cannot be watched, instead of retrying', async () => {
    mocks.watch.mockResolvedValue({
      ok: false,
      unwatchable: true,
      message: "Orca can't watch your Downloads folder. Add the file instead."
    })
    const onClient = vi.fn()
    const { result } = renderHook(() => useCaptureClientKey(DOWNLOADS, onClient))
    await waitFor(() => expect(result.current.gaveUp).toBe(true))
    expect(result.current.error).toContain('Add the file')
    expect(mocks.watch).toHaveBeenCalledTimes(1)
    expect(onClient).not.toHaveBeenCalled()
  })

  it('waits for the next download after a wrong key', async () => {
    const onClient = vi.fn().mockRejectedValueOnce(new Error('This is a Web app client.'))
    mocks.watch
      .mockResolvedValueOnce({ ok: true, text: 'web key' })
      .mockReturnValueOnce(new Promise(() => {}))
    const { result } = renderHook(() => useCaptureClientKey(DOWNLOADS, onClient))
    await waitFor(() => expect(result.current.error).toBe('This is a Web app client.'))
    await waitFor(() => expect(mocks.watch).toHaveBeenCalledTimes(2))
    expect(result.current.gaveUp).toBe(false)
  })
})
