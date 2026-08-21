import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { resolveInterfaceSectionSummary } from './appearance-interface-summary'

describe('resolveInterfaceSectionSummary', () => {
  it('includes theme, language, and font when the language setting is shown', () => {
    const settings = {
      ...getDefaultSettings('/tmp'),
      theme: 'dark' as const,
      uiLanguage: 'zh' as const,
      appFontFamily: 'Inter'
    }

    expect(resolveInterfaceSectionSummary(settings)).toBe('Dark · 中文（简体） · Inter')
  })

  it('falls back to the default font label when app font is empty', () => {
    const settings = {
      ...getDefaultSettings('/tmp'),
      theme: 'light' as const,
      uiLanguage: 'system' as const,
      appFontFamily: ''
    }

    expect(resolveInterfaceSectionSummary(settings)).toBe('Light · System · Default font')
  })
})
