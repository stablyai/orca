import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  acquireAppBackgroundBlobUrl,
  peekSettledAppBackgroundBlobUrl
} from './app-background-blob-cache'

const IMAGE_ID = '11111111-1111-4111-8111-111111111111.png'

describe('app background blob cache', () => {
  const read = vi.fn()
  const createObjectURL = vi.fn()
  const revokeObjectURL = vi.fn()

  beforeEach(() => {
    read.mockReset().mockResolvedValue(new ArrayBuffer(4))
    let next = 0
    createObjectURL.mockReset().mockImplementation(() => `blob:test-${++next}`)
    revokeObjectURL.mockReset()
    vi.stubGlobal('window', { api: { appBackground: { read } } })
    vi.stubGlobal('URL', { createObjectURL, revokeObjectURL })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('shares one blob URL between holders and revokes it after the last release', async () => {
    const first = acquireAppBackgroundBlobUrl({ id: IMAGE_ID })
    const second = acquireAppBackgroundBlobUrl({ id: IMAGE_ID })
    expect(peekSettledAppBackgroundBlobUrl({ id: IMAGE_ID })).toBeNull()

    await expect(first.url).resolves.toBe('blob:test-1')
    await expect(second.url).resolves.toBe('blob:test-1')
    expect(read).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledWith({ id: IMAGE_ID, staging: undefined })
    expect(peekSettledAppBackgroundBlobUrl({ id: IMAGE_ID })).toEqual({ url: 'blob:test-1' })

    first.release()
    first.release()
    expect(revokeObjectURL).not.toHaveBeenCalled()
    second.release()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test-1')
    expect(peekSettledAppBackgroundBlobUrl({ id: IMAGE_ID })).toBeNull()
  })

  it('keys staging and saved images separately', async () => {
    const saved = acquireAppBackgroundBlobUrl({ id: IMAGE_ID })
    const staged = acquireAppBackgroundBlobUrl({ id: IMAGE_ID, staging: true })
    await Promise.all([saved.url, staged.url])
    expect(read).toHaveBeenCalledWith({ id: IMAGE_ID, staging: true })
    expect(read).toHaveBeenCalledTimes(2)
    saved.release()
    staged.release()
  })

  it('revokes a URL that finishes loading after its holder released it', async () => {
    const handle = acquireAppBackgroundBlobUrl({ id: IMAGE_ID })
    handle.release()

    await expect(handle.url).resolves.toBeNull()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:test-1')
  })

  it('resolves null when main has no bytes (missing file or web stub)', async () => {
    read.mockResolvedValueOnce(undefined)
    const handle = acquireAppBackgroundBlobUrl({ id: IMAGE_ID })
    await expect(handle.url).resolves.toBeNull()
    expect(createObjectURL).not.toHaveBeenCalled()
    expect(peekSettledAppBackgroundBlobUrl({ id: IMAGE_ID })).toEqual({ url: null })
    handle.release()
  })
})
