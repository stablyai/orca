// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest'
import { getContextualTour } from '../../../../shared/contextual-tours'
import { setRendererUiLanguage } from '@/i18n/i18n'
import {
  getContextualTourDisplayProgress,
  getContextualTourMeasurementAction,
  measureContextualTourOverlayRenderState,
  isContextualTourLastDisplayStep
} from './contextual-tour-overlay-measurement'

afterEach(async () => {
  document.body.replaceChildren()
  await setRendererUiLanguage('en')
})

describe('contextual tour overlay measurement', () => {
  it('renders the automation tour copy in Korean when the UI locale is Korean', async () => {
    await setRendererUiLanguage('ko')
    const target = document.createElement('button')
    target.setAttribute('data-contextual-tour-target', 'automations-create')
    target.getBoundingClientRect = () => new DOMRect(0, 0, 20, 20)
    document.body.appendChild(target)

    const result = measureContextualTourOverlayRenderState({
      tour: getContextualTour('automations'),
      activeStepIndex: 0,
      sidebarOpen: true,
      keybindings: undefined,
      previousTelemetryTotalSteps: 0
    })

    expect(result.kind).toBe('render')
    if (result.kind !== 'render') {
      throw new Error(`Expected render result, received ${result.kind}`)
    }
    expect(result.renderState.title).toBe('자동화란 무엇인가요?')
    expect(result.renderState.body).toBe(
      '자동화는 일정에 따라 agent 작업을 실행합니다. 이 버튼을 눌러 자동화를 추가하세요.'
    )
  })

  it('renders the automation results step in Korean when the UI locale is Korean', async () => {
    await setRendererUiLanguage('ko')
    const target = document.createElement('div')
    target.setAttribute('data-contextual-tour-target', 'automations-runs')
    target.getBoundingClientRect = () => new DOMRect(0, 0, 20, 20)
    document.body.appendChild(target)

    const result = measureContextualTourOverlayRenderState({
      tour: getContextualTour('automations'),
      activeStepIndex: 1,
      sidebarOpen: true,
      keybindings: undefined,
      previousTelemetryTotalSteps: 0
    })

    expect(result.kind).toBe('render')
    if (result.kind !== 'render') {
      throw new Error(`Expected render result, received ${result.kind}`)
    }
    expect(result.renderState.title).toBe('결과 확인')
    expect(result.renderState.body).toBe(
      '실행 내역에서 자동화가 언제 실행되었는지, 어떤 일이 발생했는지, 출력을 어디서 확인할 수 있는지 볼 수 있습니다.'
    )
  })

  it('keeps localized copy on its own step when a step is inserted before it', async () => {
    await setRendererUiLanguage('ko')
    const target = document.createElement('button')
    target.setAttribute('data-contextual-tour-target', 'automations-create')
    target.getBoundingClientRect = () => new DOMRect(0, 0, 20, 20)
    document.body.appendChild(target)

    const automations = getContextualTour('automations')
    const result = measureContextualTourOverlayRenderState({
      tour: {
        ...automations,
        steps: [
          {
            title: 'Inserted step',
            body: 'Added ahead of the localized steps.',
            targetSelector: '[data-contextual-tour-target="automations-create"]'
          },
          ...automations.steps
        ]
      },
      activeStepIndex: 1,
      sidebarOpen: true,
      keybindings: undefined,
      previousTelemetryTotalSteps: 0
    })

    expect(result.kind).toBe('render')
    if (result.kind !== 'render') {
      throw new Error(`Expected render result, received ${result.kind}`)
    }
    expect(result.renderState.title).toBe('자동화란 무엇인가요?')
  })

  it('shows all defined browser steps in progress even when step 3 is hidden', () => {
    const tour = getContextualTour('browser')

    expect(
      getContextualTourDisplayProgress({
        tour,
        visibleStepIndexes: [0, 1],
        stepIndex: 1,
        activeStep: tour.steps[1]
      })
    ).toEqual({ current: 2, total: 3 })
  })

  it('waits for the browser cookie step target instead of cancelling', () => {
    const tour = getContextualTour('browser')

    expect(
      getContextualTourMeasurementAction({
        tour,
        visibleStepIndexes: [0, 1],
        activeStepIndex: 2
      })
    ).toEqual({ kind: 'wait' })
  })

  it('treats browser step 3 as the last display step', () => {
    const tour = getContextualTour('browser')

    expect(
      isContextualTourLastDisplayStep({
        tour,
        activeStepIndex: 2,
        progress: { current: 3, total: 3 }
      })
    ).toBe(true)
  })
})
