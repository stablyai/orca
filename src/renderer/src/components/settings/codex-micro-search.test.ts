import { describe, expect, it, vi } from 'vitest'
import { getCodexMicroSearchEntries } from './codex-micro-search'

vi.mock('@/i18n/i18n', () => ({
  i18n: { language: 'en' },
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('./settings-search-keywords', () => ({
  translateSearchKeyword: (_key: string, fallback: string) => [fallback]
}))

describe('getCodexMicroSearchEntries', () => {
  it('indexes ownership, lighting, dial, mapping, and firmware terms', () => {
    const text = JSON.stringify(getCodexMicroSearchEntries()).toLowerCase()
    for (const term of ['codex micro', 'lighting', 'brightness', 'dial', 'mapping', 'firmware']) {
      expect(text).toContain(term)
    }
  })
})
