import { beforeEach, describe, expect, it } from 'vitest'
import { i18n, setRendererUiLanguage } from '@/i18n/i18n'
import { UI_LANGUAGE_ENGLISH, UI_LANGUAGE_SPANISH } from '../../../../shared/ui-language'
import { getAgentsSteps } from '../../../../shared/agents-orchestration-steps'
import { getReviewSteps } from '../../../../shared/review-steps'
import { getWorkbenchSteps } from '../../../../shared/workbench-steps'
import {
  getLocalizedAgentsSteps,
  getLocalizedReviewSteps,
  getLocalizedWorkbenchSteps
} from './feature-wall-tour-step-copy'

describe('feature-wall-tour-step-copy', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('returns the English fallback copy matching the raw shared data by default', () => {
    const localizedAgentsSteps = getLocalizedAgentsSteps()
    const rawAgentsSteps = getAgentsSteps()
    expect(localizedAgentsSteps.map((step) => step.id)).toEqual(rawAgentsSteps.map((s) => s.id))
    localizedAgentsSteps.forEach((step, index) => {
      expect(step.name).toBe(rawAgentsSteps[index].name)
      expect(step.subtitle).toBe(rawAgentsSteps[index].subtitle)
      expect(step.description).toBe(rawAgentsSteps[index].description)
    })

    const localizedReviewSteps = getLocalizedReviewSteps()
    const rawReviewSteps = getReviewSteps()
    localizedReviewSteps.forEach((step, index) => {
      expect(step.name).toBe(rawReviewSteps[index].name)
      expect(step.subtitle).toBe(rawReviewSteps[index].subtitle)
      expect(step.description).toBe(rawReviewSteps[index].description)
    })

    const localizedWorkbenchSteps = getLocalizedWorkbenchSteps()
    const rawWorkbenchSteps = getWorkbenchSteps()
    localizedWorkbenchSteps.forEach((step, index) => {
      expect(step.name).toBe(rawWorkbenchSteps[index].name)
      expect(step.subtitle).toBe(rawWorkbenchSteps[index].subtitle)
      expect(step.description).toBe(rawWorkbenchSteps[index].description)
    })
  })

  it('preserves non-copy fields such as optional flags and ids', () => {
    const usageStep = getLocalizedAgentsSteps().find((step) => step.id === 'usage')
    expect(usageStep?.optional).toBe(true)
    const statusesStep = getLocalizedAgentsSteps().find((step) => step.id === 'statuses')
    expect(statusesStep?.optional).toBeUndefined()
  })

  it('does not throw when switching UI language, and keeps the same step ids', async () => {
    await setRendererUiLanguage(UI_LANGUAGE_SPANISH)
    expect(() => getLocalizedAgentsSteps()).not.toThrow()
    expect(() => getLocalizedReviewSteps()).not.toThrow()
    expect(() => getLocalizedWorkbenchSteps()).not.toThrow()
    expect(getLocalizedAgentsSteps().map((step) => step.id)).toEqual(
      getAgentsSteps().map((step) => step.id)
    )
    await setRendererUiLanguage(UI_LANGUAGE_ENGLISH)
  })
})
