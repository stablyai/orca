import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import { mergeSettings } from './preload-api/web-preference-normalization'

describe('browser-local chat appearance settings', () => {
  it('normalizes writes and old stored values, and preserves unrelated settings', () => {
    const base = getDefaultSettings('/tmp')
    const saved = mergeSettings(base, {
      nativeChatAppearance: { fontSize: 99, codeFontSize: 1, width: 'wide' }
    })
    expect(saved.nativeChatAppearance).toEqual({ fontSize: 20, codeFontSize: 10, width: 'wide' })
    expect(mergeSettings(saved, { theme: 'light' }).nativeChatAppearance).toEqual(
      saved.nativeChatAppearance
    )
    expect(
      mergeSettings(saved, { nativeChatAppearance: undefined }).nativeChatAppearance
    ).toBeUndefined()
    expect(
      mergeSettings(saved, {
        nativeChatAppearance: { fontSize: 14, codeFontSize: 12, width: 'comfortable' }
      }).nativeChatAppearance
    ).toBeUndefined()
  })
})
