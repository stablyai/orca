// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { CONTEXTUAL_TOURS, type ContextualTour } from '../../../../shared/contextual-tours'
import { setRendererUiLanguage } from '@/i18n/i18n'
import { getLocalizedContextualTourStepCopy } from './contextual-tour-step-copy'

afterEach(async () => {
  await setRendererUiLanguage('en')
})

describe('contextual tour step copy', () => {
  it('translates every tour step, so no step falls back to English mid-tour', async () => {
    await setRendererUiLanguage('ko')

    for (const tour of CONTEXTUAL_TOURS as readonly ContextualTour[]) {
      for (const step of tour.steps) {
        const copy = getLocalizedContextualTourStepCopy(step.id)
        expect(copy, `${tour.id} step "${step.title}" has no localized copy`).toBeDefined()
        expect(copy?.title).not.toBe(step.title)
        expect(copy?.body).not.toBe(step.body)
        if (step.primaryAction) {
          expect(copy?.primaryActionLabel).not.toBe(step.primaryAction.label)
        }
      }
    }
  })

  it('renders the floating workspace copy in Korean', async () => {
    await setRendererUiLanguage('ko')

    expect(getLocalizedContextualTourStepCopy('floating-workspace-scratchpad')?.title).toBe(
      '스크래치패드로도 사용하기'
    )
  })

  it('falls back to English copy for the active locale', () => {
    expect(getLocalizedContextualTourStepCopy('floating-workspace-repos')?.title).toBe(
      'Run an agent across every repo'
    )
  })
})
