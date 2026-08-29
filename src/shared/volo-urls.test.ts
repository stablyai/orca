import { describe, expect, it } from 'vitest'
import {
  DEFAULT_VOLO_WEB_URL,
  deriveVoloWebUrl,
  isVoloTaskUrl,
  normalizeVoloApiUrl,
  parseVoloTaskUrl,
  voloTaskWebUrl
} from './volo-urls'

describe('volo urls', () => {
  it('normalizes production API URLs and derives the web origin', () => {
    expect(normalizeVoloApiUrl('volo.api.jaak.ai/')).toBe('https://volo.api.jaak.ai')
    expect(deriveVoloWebUrl('https://volo.api.jaak.ai')).toBe(DEFAULT_VOLO_WEB_URL)
    expect(deriveVoloWebUrl('https://volo.api.dev.jaak.ai')).toBe('https://volo.dev.jaak.ai')
  })

  it('builds and parses task links', () => {
    expect(voloTaskWebUrl('https://volo.jaak.ai/', 'dd-12')).toBe('https://volo.jaak.ai/t/dd-12')
    expect(parseVoloTaskUrl('https://volo.jaak.ai/t/DD-12')).toEqual({
      origin: 'https://volo.jaak.ai',
      taskCode: 'DD-12'
    })
    expect(isVoloTaskUrl('https://volo.jaak.ai/boards/abc')).toBe(false)
  })

  it('rejects non-HTTPS remote API URLs', () => {
    expect(() => normalizeVoloApiUrl('http://volo.api.jaak.ai')).toThrow(/HTTPS/)
  })
})
