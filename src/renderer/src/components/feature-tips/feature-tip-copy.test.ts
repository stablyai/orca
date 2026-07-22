import { beforeEach, describe, expect, it } from 'vitest'
import { i18n, setRendererUiLanguage } from '@/i18n/i18n'
import { UI_LANGUAGE_ENGLISH, UI_LANGUAGE_SPANISH } from '../../../../shared/ui-language'
import { FEATURE_TIPS } from '../../../../shared/feature-tips'
import { getLocalizedFeatureTip, getLocalizedFeatureTips } from './feature-tip-copy'

describe('feature-tip-copy', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('returns the English fallback copy by default', () => {
    const tips = getLocalizedFeatureTips()
    const cliTip = tips.find((tip) => tip.id === 'orca-cli')
    expect(cliTip?.eyebrow).toBe('Tip')
    expect(cliTip?.title).toBe('Let agents drive Orca with the Orca CLI')
    expect(cliTip?.description).toBe(
      'Enable agents to coordinate child worktrees and communicate between worktrees.'
    )
    expect(cliTip?.ctaLabel).toBe('Install CLI & Skills')
  })

  it('localizes tip copy once the UI language changes', async () => {
    await setRendererUiLanguage(UI_LANGUAGE_SPANISH)
    const tips = getLocalizedFeatureTips()
    const cliTip = tips.find((tip) => tip.id === 'orca-cli')
    expect(cliTip?.title).not.toBe('Let agents drive Orca with the Orca CLI')
    await setRendererUiLanguage(UI_LANGUAGE_ENGLISH)
  })

  it('localizes a single resolved tip while preserving non-copy fields', () => {
    const rawTip = FEATURE_TIPS.find((tip) => tip.id === 'voice-dictation')
    if (!rawTip) {
      throw new Error('Expected voice-dictation feature tip fixture')
    }

    const localized = getLocalizedFeatureTip(rawTip)
    expect(localized.id).toBe('voice-dictation')
    expect(localized.action).toBe('enable-voice')
    expect(localized.title).toBe('Voice Dictation is here')
    expect(localized.ctaLabel).toBe('Set Up Voice')
  })
})
