import { describe, expect, it } from 'vitest'
import { normalizeTypedName, storedNameMatcher } from './typed-name-normalization'

describe('name matching across Unicode normalization forms', () => {
  it('treats composed and decomposed spellings as one name without changing case rules', () => {
    const composed = 'Ag\u00eancia'
    const decomposed = 'Age\u0302ncia'

    expect(normalizeTypedName(decomposed)).toBe(normalizeTypedName('AG\u00caNCIA'))
    // Lowercasing J + U+030C leaves j + U+030C; only NFC after lowercasing composes it to U+01F0.
    expect(normalizeTypedName('J\u030c')).toBe(normalizeTypedName('\u01f0'))
    expect(storedNameMatcher(composed)(decomposed)).toBe(true)
    expect(storedNameMatcher('ag\u00eancia')(decomposed)).toBe(false)
  })
})
