import { describe, expect, it } from 'vitest'
import { isWebClientLocation } from './web-client-location'

describe('isWebClientLocation', () => {
  it('treats a window without location as a non-web environment', () => {
    Object.defineProperty(globalThis, 'window', { configurable: true, value: {} })

    try {
      expect(isWebClientLocation()).toBe(false)
    } finally {
      Reflect.deleteProperty(globalThis, 'window')
    }
  })
})
