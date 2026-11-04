// @vitest-environment happy-dom

import { act, type ReactElement, type RefObject } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContextualTourId } from '../../../../shared/contextual-tours'
import { getContextualTourCleanupOutcome } from './contextual-tour-overlay-measurement'
import {
  ContextualTourOverlaySurface,
  handleContextualTourGlobalKeyDown,
  handleContextualTourOverlayKeyDown,
  type ActiveTourRenderState
} from './ContextualTourOverlaySurface'
import { getContextualTourPanelHost } from './contextual-tour-gate'
import { useAppStore } from '@/store'
import { i18n, loadRendererUiLanguage } from '@/i18n/i18n'

const baseRenderState: ActiveTourRenderState = {
  rect: {
    left: 10,
    top: 20,
    right: 110,
    bottom: 80,
    width: 100,
    height: 60
  } as DOMRect,
  // autoUpdate needs a real DOM node for geometry, not a closest stub.
  targetElement: document.createElement('div'),
  progress: { current: 1, total: 3 },
  title: 'Choose the work source',
  body: 'Switch between connected providers and project filters without changing pages.',
  isLastStep: false,
  isFirstStep: true,
  panelHost: null
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function renderSurface(
  overrides: Partial<ActiveTourRenderState> = {},
  callbacks: {
    onSkip?: (id: ContextualTourId) => void
    onNext?: () => void
    onBack?: () => void
    onStepAction?: Parameters<typeof ContextualTourOverlaySurface>[0]['onStepAction']
  } = {},
  activeTourId: ContextualTourId = 'tasks'
): ReactElement {
  const renderState = { ...baseRenderState, ...overrides }
  return (
    <ContextualTourOverlaySurface
      activeTourId={activeTourId}
      renderState={renderState}
      panelRef={{ current: null } as RefObject<HTMLElement | null>}
      panelHost={renderState.panelHost}
      onSkip={callbacks.onSkip ?? vi.fn()}
      onBack={callbacks.onBack ?? vi.fn()}
      onNext={callbacks.onNext ?? vi.fn()}
      onStepAction={callbacks.onStepAction ?? vi.fn()}
      onOverlayKeyDownCapture={handleContextualTourOverlayKeyDown}
    />
  )
}

function renderSurfaceInDom(
  overrides: Partial<ActiveTourRenderState> = {},
  callbacks: Parameters<typeof renderSurface>[1] = {}
): void {
  act(() => {
    root.render(renderSurface(overrides, callbacks))
  })
}

function getButtonByText(text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
    (element) => element.textContent?.includes(text)
  )
  if (!button) {
    throw new Error(`button not rendered: ${text}`)
  }
  return button
}

function getButtonByAriaLabel(label: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
  if (!button) {
    throw new Error(`button not rendered: ${label}`)
  }
  return button
}

describe('ContextualTourOverlaySurface', () => {
  it('renders visible progress and step copy', () => {
    const markup = renderToStaticMarkup(renderSurface())

    expect(markup).toContain('aria-valuenow="1"')
    expect(markup).toContain('aria-valuemax="3"')
    expect(markup).toContain('Step 1 of 3')
    expect(markup).toContain('1 of 3')
    expect(markup).toContain('Choose the work source')
    expect(markup).toContain('Switch between connected providers')
    expect(markup).toContain('aria-label="Skip tour"')
    expect(markup).toContain('Next')
  })

  it('treats externally completed tours as completed during cleanup', () => {
    useAppStore.setState({ lastCompletedContextualTourId: 'workspace-agent-sessions' })

    expect(getContextualTourCleanupOutcome('workspace-agent-sessions')).toBe('completed')
    expect(getContextualTourCleanupOutcome('tasks')).toBe('cancelled')
  })

  it('renders later progress and Done on the final visible step', () => {
    const markup = renderToStaticMarkup(
      renderSurface({
        progress: { current: 2, total: 2 },
        title: 'Start from work items',
        isLastStep: true,
        isFirstStep: false
      })
    )

    expect(markup).toContain('aria-valuenow="2"')
    expect(markup).toContain('aria-valuemax="2"')
    expect(markup).toContain('2 of 2')
    expect(markup).toContain('Start from work items')
    expect(markup).toContain('Done')
  })

  it('does not render a step label for single-step tours', () => {
    const markup = renderToStaticMarkup(
      renderSurface({
        progress: { current: 1, total: 1 },
        title: 'Split panes for agents',
        isLastStep: true,
        isFirstStep: true
      })
    )

    expect(markup).not.toContain('Step 1')
    expect(markup).toContain('Split panes for agents')
  })

  it('renders configured step controls inside the tour panel', () => {
    const markup = renderToStaticMarkup(
      renderSurface({
        control: { kind: 'auto-rename-branch-from-work' },
        title: 'Name it, or start from existing work',
        body: 'Start a workspace from a task source to inherit the title.'
      })
    )

    expect(markup).toContain('Auto-name from first message')
    expect(markup).toContain('role="switch"')
    expect(markup).toContain('Auto-name workspace from first agent message')
  })

  it('hides the Back button on the first visible step', () => {
    const markup = renderToStaticMarkup(renderSurface({ isFirstStep: true }))
    expect(markup).not.toContain('>Back<')
  })

  it('shows the Back button on later steps and wires the callback', () => {
    const onBack = vi.fn()
    renderSurfaceInDom({ progress: { current: 2, total: 3 }, isFirstStep: false }, { onBack })

    getButtonByText('Back').click()

    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('wires Skip and Next callbacks', () => {
    const onSkip = vi.fn()
    const onNext = vi.fn()
    renderSurfaceInDom({}, { onSkip, onNext })

    getButtonByAriaLabel('Skip tour').click()
    getButtonByText('Next').click()

    expect(onSkip).toHaveBeenCalledWith('tasks')
    expect(onNext).toHaveBeenCalledTimes(1)
  })

  it('renders configured step action labels and wires them through the action callback', () => {
    const onStepAction = vi.fn()
    const primaryAction = { kind: 'split-terminal-pane' as const, label: 'Split terminal' }
    const secondaryAction = { kind: 'next' as const, label: 'Skip' }
    renderSurfaceInDom(
      {
        primaryAction,
        secondaryAction
      },
      { onStepAction }
    )

    getButtonByText('Split terminal').click()
    getButtonByText('Skip').click()

    expect(onStepAction).toHaveBeenCalledWith(primaryAction)
    expect(onStepAction).toHaveBeenCalledWith(secondaryAction)
  })

  it('renders target rings only for steps that request a target pulse', () => {
    const pulsedMarkup = renderToStaticMarkup(
      renderSurface({
        targetPulse: true,
        title: 'Start another task in parallel'
      })
    )
    const defaultMarkup = renderToStaticMarkup(renderSurface())

    expect(pulsedMarkup).toContain('data-contextual-tour-target-rings')
    expect(defaultMarkup).not.toContain('data-contextual-tour-target-rings')
  })

  it('can hide the primary action when the real target is the CTA', () => {
    const markup = renderToStaticMarkup(
      renderSurface({
        hidePrimaryAction: true,
        isLastStep: true,
        title: 'Start another task in parallel'
      })
    )

    expect(markup).not.toContain('Done')
    expect(markup).not.toContain('Next')
  })

  it('handles Escape by clicking Skip before page-level handlers see it', () => {
    const click = vi.fn()
    const preventDefault = vi.fn()
    const stopPropagation = vi.fn()

    handleContextualTourOverlayKeyDown({
      key: 'Escape',
      preventDefault,
      stopPropagation,
      currentTarget: {
        querySelector: () => ({ click })
      }
    } as unknown as Parameters<typeof handleContextualTourOverlayKeyDown>[0])

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(stopPropagation).toHaveBeenCalledTimes(1)
    expect(click).toHaveBeenCalledTimes(1)
  })

  it('handles global Escape through the panel button so telemetry callbacks run', () => {
    const click = vi.fn()
    const dismissContextualTour = vi.fn()
    const preventDefault = vi.fn()
    const stopImmediatePropagation = vi.fn()
    const panel = {
      querySelector: vi.fn(() => ({ click }))
    }
    const overlay = {}

    vi.spyOn(useAppStore, 'getState').mockReturnValue({
      activeContextualTourId: 'tasks',
      dismissContextualTour
    } as unknown as ReturnType<typeof useAppStore.getState>)
    vi.stubGlobal('document', {
      querySelectorAll: () => [],
      querySelector: vi.fn((selector: string) =>
        selector === '[data-contextual-tour-overlay]'
          ? overlay
          : selector === '[data-contextual-tour-panel]'
            ? panel
            : null
      )
    })

    handleContextualTourGlobalKeyDown({
      key: 'Escape',
      preventDefault,
      stopImmediatePropagation
    } as unknown as KeyboardEvent)

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(stopImmediatePropagation).toHaveBeenCalledTimes(1)
    expect(panel.querySelector).toHaveBeenCalledWith('[data-contextual-tour-dismiss]')
    expect(click).toHaveBeenCalledTimes(1)
    expect(dismissContextualTour).not.toHaveBeenCalled()
  })

  it.each(['menu', 'listbox', 'dialog'])('leaves Escape to an open %s above the tour', (role) => {
    const onSkip = vi.fn()
    renderSurfaceInDom({}, { onSkip })
    vi.spyOn(useAppStore, 'getState').mockReturnValue({
      ...useAppStore.getState(),
      activeContextualTourId: 'tasks'
    })
    const popup = document.createElement('div')
    popup.setAttribute('role', role)
    Object.defineProperty(popup, 'getClientRects', {
      value: () => [new DOMRect(0, 0, 100, 100)]
    })
    container.appendChild(popup)
    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })

    handleContextualTourGlobalKeyDown(event)

    expect(event.defaultPrevented).toBe(false)
    expect(onSkip).not.toHaveBeenCalled()
    popup.remove()

    handleContextualTourGlobalKeyDown(event)

    expect(event.defaultPrevented).toBe(true)
    expect(onSkip).toHaveBeenCalledWith('tasks')
  })

  it('leaves Escape to the + menu while the agent sessions tour is hidden', () => {
    const onSkip = vi.fn()
    act(() => {
      root.render(renderSurface({}, { onSkip }, 'workspace-agent-sessions'))
    })
    vi.spyOn(useAppStore, 'getState').mockReturnValue({
      ...useAppStore.getState(),
      activeContextualTourId: 'workspace-agent-sessions',
      activeContextualTourStepIndex: 0
    })
    const trigger = document.createElement('button')
    trigger.dataset.contextualTourTarget = 'tab-create-menu'
    trigger.dataset.state = 'open'
    trigger.getBoundingClientRect = () => new DOMRect(0, 0, 30, 30)
    container.appendChild(trigger)
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    Object.defineProperty(menu, 'getClientRects', {
      value: () => [new DOMRect(0, 0, 100, 100)]
    })
    container.appendChild(menu)
    const overlay = container.querySelector<HTMLElement>('[data-contextual-tour-overlay]')!
    overlay.style.display = 'none'
    const firstEscape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })

    handleContextualTourGlobalKeyDown(firstEscape)

    expect(firstEscape.defaultPrevented).toBe(false)
    expect(onSkip).not.toHaveBeenCalled()

    menu.remove()
    trigger.dataset.state = 'closed'
    overlay.style.display = ''
    const nextEscape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    handleContextualTourGlobalKeyDown(nextEscape)

    expect(nextEscape.defaultPrevented).toBe(true)
    expect(onSkip).toHaveBeenCalledWith('workspace-agent-sessions')
  })

  it('still dismisses a tour teaching a menu item inside its hosting dialog', () => {
    const onSkip = vi.fn()
    renderSurfaceInDom({}, { onSkip })
    container.setAttribute('role', 'dialog')
    vi.spyOn(useAppStore, 'getState').mockReturnValue({
      ...useAppStore.getState(),
      activeContextualTourId: 'tasks',
      activeContextualTourStepIndex: 2
    })
    const hiddenTarget = document.createElement('button')
    hiddenTarget.dataset.contextualTourTarget = 'tasks-start-workspace'
    hiddenTarget.hidden = true
    container.appendChild(hiddenTarget)
    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    Object.defineProperty(menu, 'getClientRects', {
      value: () => [new DOMRect(0, 0, 100, 100)]
    })
    const target = document.createElement('button')
    target.dataset.contextualTourTarget = 'tasks-actions'
    target.getBoundingClientRect = () => new DOMRect(0, 0, 100, 30)
    menu.appendChild(target)
    container.appendChild(menu)

    handleContextualTourGlobalKeyDown(
      new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    )

    expect(onSkip).toHaveBeenCalledWith('tasks')
  })

  it('does not dismiss directly on global Escape when the panel button is missing', () => {
    const dismissContextualTour = vi.fn()
    const preventDefault = vi.fn()
    const stopImmediatePropagation = vi.fn()
    const panel = {
      querySelector: vi.fn(() => null)
    }
    const overlay = {}

    vi.spyOn(useAppStore, 'getState').mockReturnValue({
      activeContextualTourId: 'tasks',
      dismissContextualTour
    } as unknown as ReturnType<typeof useAppStore.getState>)
    vi.stubGlobal('document', {
      querySelectorAll: () => [],
      querySelector: vi.fn((selector: string) =>
        selector === '[data-contextual-tour-overlay]'
          ? overlay
          : selector === '[data-contextual-tour-panel]'
            ? panel
            : null
      )
    })

    handleContextualTourGlobalKeyDown({
      key: 'Escape',
      preventDefault,
      stopImmediatePropagation
    } as unknown as KeyboardEvent)

    expect(preventDefault).toHaveBeenCalledTimes(1)
    expect(stopImmediatePropagation).toHaveBeenCalledTimes(1)
    expect(dismissContextualTour).not.toHaveBeenCalled()
  })
})

describe('getContextualTourPanelHost', () => {
  it('hosts controls inside Radix dialog and sheet content', () => {
    const dialogHost = {} as HTMLElement
    const sheetHost = {} as HTMLElement
    const dialogTarget = { closest: vi.fn(() => dialogHost) } as unknown as Element
    const sheetTarget = { closest: vi.fn(() => sheetHost) } as unknown as Element
    const pageTarget = { closest: vi.fn(() => null) } as unknown as Element

    expect(getContextualTourPanelHost(dialogTarget)).toBe(dialogHost)
    expect(getContextualTourPanelHost(sheetTarget)).toBe(sheetHost)
    expect(getContextualTourPanelHost(pageTarget)).toBeNull()
    expect(dialogTarget.closest).toHaveBeenCalledWith(
      '[data-slot="dialog-content"], [data-slot="sheet-content"]'
    )
  })
})

function renderLocalizedSurface(isLastStep: boolean): ReactElement {
  const panelRef: RefObject<HTMLElement | null> = { current: null }
  const renderState: ActiveTourRenderState = {
    rect: new DOMRect(0, 0, 20, 20),
    targetElement: document.createElement('button'),
    progress: { current: isLastStep ? 2 : 1, total: 2 },
    title: 'Tour title',
    body: 'Tour body',
    isLastStep,
    isFirstStep: !isLastStep,
    panelHost: null
  }
  return (
    <ContextualTourOverlaySurface
      activeTourId="automations"
      renderState={renderState}
      panelRef={panelRef}
      panelHost={null}
      onSkip={vi.fn()}
      onBack={vi.fn()}
      onNext={vi.fn()}
      onStepAction={vi.fn()}
      onOverlayKeyDownCapture={handleContextualTourOverlayKeyDown}
    />
  )
}

describe('ContextualTourOverlaySurface localization', () => {
  afterEach(async () => {
    await i18n.changeLanguage(await loadRendererUiLanguage('en'))
  })

  it.each([false, true])('dismisses a localized tour with Escape (last step: %s)', async (last) => {
    await i18n.changeLanguage(await loadRendererUiLanguage('ko'))
    const onSkip = vi.fn()
    renderSurfaceInDom({ isLastStep: last }, { onSkip })
    vi.spyOn(useAppStore, 'getState').mockReturnValue({
      ...useAppStore.getState(),
      activeContextualTourId: 'tasks'
    })

    handleContextualTourGlobalKeyDown(
      new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    )

    expect(onSkip).toHaveBeenCalledWith('tasks')
  })

  it('renders default tour actions in Korean when the UI locale is Korean', async () => {
    await i18n.changeLanguage(await loadRendererUiLanguage('ko'))

    const firstStep = renderToStaticMarkup(renderLocalizedSurface(false))
    const finalStep = renderToStaticMarkup(renderLocalizedSurface(true))

    expect(firstStep).toContain('다음')
    expect(firstStep).not.toContain('>Next<')
    expect(finalStep).toContain('완료')
    expect(finalStep).not.toContain('>Done<')
  })
})
