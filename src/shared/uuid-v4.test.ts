import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUuidV4 } from './uuid-v4'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('createUuidV4', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('uses the browser crypto fallback when randomUUID is unavailable', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: (bytes: Uint8Array) => {
        bytes.fill(0xab)
        return bytes
      }
    })

    expect(createUuidV4()).toMatch(UUID_V4)
  })

  it('still returns a UUID when Web Crypto is unavailable', () => {
    vi.stubGlobal('crypto', undefined)

    expect(createUuidV4()).toMatch(UUID_V4)
  })
})
