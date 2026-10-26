import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUuidV4 } from './uuid-v4'

describe('createUuidV4', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('uses native randomUUID when it is available', () => {
    vi.stubGlobal('crypto', {
      randomUUID: () => 'native-id'
    })

    expect(createUuidV4()).toBe('native-id')
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

    expect(createUuidV4()).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f')
  })

  it('still returns a UUID when Web Crypto is unavailable', () => {
    vi.stubGlobal('crypto', undefined)
    vi.spyOn(Math, 'random').mockReturnValue(255 / 256)

    expect(createUuidV4()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff')
  })
})
