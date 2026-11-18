// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { writeWebSecretClipboardText } from './web-clipboard-api'

function stubClipboard(initial = ''): { read: () => string; writeText: ReturnType<typeof vi.fn> } {
  let current = initial
  const writeText = vi.fn(async (text: string) => {
    current = text
  })
  vi.stubGlobal('navigator', { clipboard: { writeText, readText: async () => current } })
  return { read: () => current, writeText }
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('writeWebSecretClipboardText', () => {
  it('never promises a clear, but clears an unchanged secret after a minute when it can', async () => {
    vi.useFakeTimers()
    const clipboard = stubClipboard()
    await expect(writeWebSecretClipboardText('orcawh_secret')).resolves.toEqual({
      clearsLater: false
    })
    expect(clipboard.read()).toBe('orcawh_secret')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(clipboard.read()).toBe('')
  })

  it('leaves a later copy alone', async () => {
    vi.useFakeTimers()
    const clipboard = stubClipboard()
    await writeWebSecretClipboardText('orcawh_secret')
    await navigator.clipboard.writeText('something else')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(clipboard.read()).toBe('something else')
  })

  it('copies but never throws later where the page can write and not read', async () => {
    vi.useFakeTimers()
    const writeText = vi.fn(async () => {})
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    await writeWebSecretClipboardText('orcawh_secret')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(writeText).toHaveBeenCalledTimes(1)
  })
})
