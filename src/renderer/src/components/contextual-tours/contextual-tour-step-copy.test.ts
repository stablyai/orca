import { beforeEach, describe, expect, it } from 'vitest'
import { i18n, setRendererUiLanguage } from '@/i18n/i18n'
import { UI_LANGUAGE_ENGLISH, UI_LANGUAGE_SPANISH } from '../../../../shared/ui-language'
import { getContextualTour } from '../../../../shared/contextual-tours'
import {
  getContextualTourStepKey,
  getLocalizedContextualTour,
  getLocalizedContextualTourStep
} from './contextual-tour-step-copy'

describe('contextual-tour-step-copy', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
  })

  it('returns the English fallback copy by default', () => {
    const tour = getLocalizedContextualTour('workspace-board')
    expect(tour.steps[0]?.title).toBe('Plan work on the board')
    expect(tour.steps[0]?.body).toBe(
      'Use the board when you want to see workspaces by status instead of by project.'
    )
  })

  it('returns the English fallback for action labels by default', () => {
    const tour = getLocalizedContextualTour('workspace-agent-sessions')
    expect(tour.steps[0]?.primaryAction?.label).toBe('Split terminal')
  })

  it('derives the step key from the target selector rather than array index', () => {
    const rawSteps = getContextualTour('workspace-board').steps
    expect(getContextualTourStepKey(rawSteps[0]!)).toBe('workspace-board-center')
    expect(getContextualTourStepKey(rawSteps[1]!)).toBe('workspace-board-done-lane')
  })

  it('localizes step copy once the UI language changes', async () => {
    await setRendererUiLanguage(UI_LANGUAGE_SPANISH)
    // Locale JSON files are merged separately; inject a resource here to prove
    // the wrapper picks up a translated value once one exists for the active locale.
    i18n.addResource(
      'es',
      'translation',
      'contextualTours.workspace-board.workspace-board-center.title',
      'Planifica el trabajo en el tablero'
    )

    const rawStep = getContextualTour('workspace-board').steps[0]!
    const localizedStep = getLocalizedContextualTourStep('workspace-board', rawStep)

    expect(localizedStep.title).toBe('Planifica el trabajo en el tablero')
    expect(localizedStep.title).not.toBe(rawStep.title)
    await setRendererUiLanguage(UI_LANGUAGE_ENGLISH)
  })
})
