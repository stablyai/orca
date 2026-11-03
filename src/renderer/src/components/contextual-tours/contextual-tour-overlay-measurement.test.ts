// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { getContextualTour } from '../../../../shared/contextual-tours'
import { i18n, loadRendererUiLanguage } from '@/i18n/i18n'
import { measureContextualTourOverlayRenderState } from './contextual-tour-overlay-measurement'

afterEach(async () => {
  document.body.replaceChildren()
  await i18n.changeLanguage(await loadRendererUiLanguage('en'))
})

describe('contextual tour overlay measurement', () => {
  it('localizes the title, shortcut body, and action label of non-automation steps', async () => {
    await i18n.changeLanguage(await loadRendererUiLanguage('ko'))
    const target = document.createElement('div')
    target.setAttribute('data-contextual-tour-target', 'terminal-pane-split-target')
    target.getBoundingClientRect = () => new DOMRect(0, 0, 20, 20)
    document.body.appendChild(target)

    const result = measureContextualTourOverlayRenderState({
      tour: getContextualTour('workspace-agent-sessions'),
      activeStepIndex: 0,
      sidebarOpen: true,
      keybindings: undefined,
      previousTelemetryTotalSteps: 0
    })

    expect(result.kind).toBe('render')
    if (result.kind !== 'render') {
      throw new Error(`Expected render result, received ${result.kind}`)
    }
    expect(result.renderState.title).toBe('터미널 창 분할')
    expect(result.renderState.body).not.toContain('{terminal.splitRight}')
    expect(result.renderState.body).toContain('두 번째 터미널 창을 열거나')
    expect(result.renderState.primaryAction).toEqual({
      kind: 'split-terminal-pane',
      label: '터미널 분할'
    })
  })

  it('keeps localized copy on its own step when a step is inserted before it', async () => {
    await i18n.changeLanguage(await loadRendererUiLanguage('ko'))
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
            id: 'inserted-step',
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
})

const { rejectAppStoreAccess } = vi.hoisted(() => ({
  rejectAppStoreAccess: vi.fn(() => {
    throw new Error('Pure helper tests must not access the app store')
  })
}))

vi.mock('@/store', () => ({
  useAppStore: Object.assign(rejectAppStoreAccess, {
    getState: rejectAppStoreAccess,
    getInitialState: rejectAppStoreAccess,
    setState: rejectAppStoreAccess,
    subscribe: rejectAppStoreAccess
  })
}))

afterEach(() => {
  expect(rejectAppStoreAccess).not.toHaveBeenCalled()
})
