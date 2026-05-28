import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBrowserUuid } from './browser-uuid'

describe('createBrowserUuid', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses native randomUUID when it is available', () => {
    vi.stubGlobal('crypto', {
      randomUUID: () => 'native-id'
    })

    expect(createBrowserUuid()).toBe('native-id')
  })

  it('falls back to getRandomValues when randomUUID is unavailable', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => {
        for (let index = 0; index < bytes.length; index += 1) {
          bytes[index] = index
        }
        return bytes
      }
    })

    expect(createBrowserUuid()).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f')
  })
})
