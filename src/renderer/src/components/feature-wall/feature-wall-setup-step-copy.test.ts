import { beforeEach, describe, expect, it } from 'vitest'
import { i18n, setRendererUiLanguage } from '@/i18n/i18n'
import { UI_LANGUAGE_ENGLISH, UI_LANGUAGE_SPANISH } from '../../../../shared/ui-language'
import {
  getLocalizedFeatureWallSetupSteps,
  getLocalizedFeatureWallSetupStepsForSection
} from './feature-wall-setup-step-copy'

describe('feature-wall-setup-step-copy', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('returns the English fallback copy by default', () => {
    const steps = getLocalizedFeatureWallSetupSteps()
    const defaultAgentStep = steps.find((step) => step.id === 'default-agent')
    expect(defaultAgentStep?.name).toBe('Choose your default agent')
    expect(defaultAgentStep?.description).toBe(
      'Start new work faster with your preferred agent already selected.'
    )
  })

  it('localizes step copy once the UI language changes', async () => {
    await setRendererUiLanguage(UI_LANGUAGE_SPANISH)
    const steps = getLocalizedFeatureWallSetupSteps()
    const defaultAgentStep = steps.find((step) => step.id === 'default-agent')
    expect(defaultAgentStep?.name).not.toBe('Choose your default agent')
    await setRendererUiLanguage(UI_LANGUAGE_ENGLISH)
  })

  it('filters localized steps by section', () => {
    const setupSteps = getLocalizedFeatureWallSetupStepsForSection('setup')
    const parallelWorkSteps = getLocalizedFeatureWallSetupStepsForSection('parallel-work')
    expect(setupSteps.some((step) => step.id === 'two-worktrees')).toBe(false)
    expect(parallelWorkSteps.some((step) => step.id === 'two-worktrees')).toBe(true)
  })
})
