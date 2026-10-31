// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { clipboardHasImage } from './preload-api/web-clipboard-api'

afterEach(() => vi.unstubAllGlobals())

describe('browser clipboard image presence', () => {
  it.each([
    ['text/plain', false],
    ['image/png', true]
  ] as const)('detects %s without reading image bytes', async (type, expected) => {
    const getType = vi.fn()
    vi.stubGlobal('navigator', { clipboard: { read: async () => [{ types: [type], getType }] } })
    expect(await clipboardHasImage()).toBe(expected)
    expect(getType).not.toHaveBeenCalled()
  })

  it('reports unknown when the browser has no clipboard reader', async () => {
    vi.stubGlobal('navigator', {})
    expect(await clipboardHasImage()).toBeNull()
  })

  it('preserves permission errors for the caller to handle independently of text', async () => {
    vi.stubGlobal('navigator', {
      clipboard: {
        read: async () => {
          throw new Error('denied')
        }
      }
    })
    await expect(clipboardHasImage()).rejects.toThrow('denied')
  })
})
