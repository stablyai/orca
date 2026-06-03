import { Children, isValidElement, type ReactElement, type ReactNode, type RefObject } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ContextualTourId } from '../../../../shared/contextual-tours'
import { getContextualTourCleanupOutcome } from './ContextualTourOverlay'
import {
  ContextualTourOverlaySurface,
  handleContextualTourGlobalKeyDown,
  handleContextualTourOverlayKeyDown,
  type ActiveTourRenderState
} from './ContextualTourOverlaySurface'
import { getContextualTourPanelHost } from './contextual-tour-gate'
import { useAppStore } from '@/store'

type ClickableElementProps = {
  children?: ReactNode
  onClick?: () => void
  'aria-label'?: string
}

const baseRenderState: ActiveTourRenderState = {
  rect: {
    left: 10,
    top: 20,
    right: 110,
    bottom: 80,
    width: 100,
    height: 60
  } as DOMRect,
  targetElement: {
    closest: () => null
  } as unknown as Element,
  progress: { current: 1, total: 3 },
  title: 'Choose the work source',
  body: 'Switch between connected providers and project filters without changing pages.',
  isLastStep: false,
  isFirstStep: true,
  panelHost: null
}

afterEach(() => {
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
  } = {}
): ReactElement {
  const renderState = { ...baseRenderState, ...overrides }
  return ContextualTourOverlaySurface({
    activeTourId: 'tasks',
    renderState,
    panelRef: { current: null } as RefObject<HTMLElement | null>,
    panelPosition: { left: 130, top: 20, '--contextual-tour-arrow-offset': '40px' },
    panelPlacement: 'right',
    panelHost: renderState.panelHost,
    onSkip: callbacks.onSkip ?? vi.fn(),
    onBack: callbacks.onBack ?? vi.fn(),
    onNext: callbacks.onNext ?? vi.fn(),
    onStepAction: callbacks.onStepAction ?? vi.fn(),
    onOverlayKeyDownCapture: handleContextualTourOverlayKeyDown
  })
}

function findElementByText(
  node: ReactNode,
  text: string
): ReactElement<ClickableElementProps> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findElementByText(child, text)
      if (match) {
        return match
      }
    }
    return null
  }

  if (!isValidElement(node)) {
    return null
  }

  const props = node.props as ClickableElementProps
  const childrenArray = Children.toArray(props.children)
  if (childrenArray.some((child) => child === text)) {
    return node as ReactElement<ClickableElementProps>
  }

  for (const child of childrenArray) {
    const match = findElementByText(child, text)
    if (match) {
      return match
    }
  }
  return null
}

function findElementByAriaLabel(
  node: ReactNode,
  label: string
): ReactElement<ClickableElementProps> | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const match = findElementByAriaLabel(child, label)
      if (match) {
        return match
      }
    }
    return null
  }

  if (!isValidElement(node)) {
    return null
  }

  const props = node.props as ClickableElementProps
  if (props['aria-label'] === label) {
    return node as ReactElement<ClickableElementProps>
  }

  for (const child of Children.toArray(props.children)) {
    const match = findElementByAriaLabel(child, label)
    if (match) {
      return match
    }
  }
  return null
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
    const element = renderSurface(
      { progress: { current: 2, total: 3 }, isFirstStep: false },
      { onBack }
    )
    const backNode = findElementByText(element, 'Back')
    expect(backNode).not.toBeNull()
    backNode?.props.onClick?.()
    expect(onBack).toHaveBeenCalledTimes(1)
  })

  it('wires Skip and Next callbacks', () => {
    const onSkip = vi.fn()
    const onNext = vi.fn()
    const element = renderSurface({}, { onSkip, onNext })

    findElementByAriaLabel(element, 'Skip tour')?.props.onClick?.()
    findElementByText(element, 'Next')?.props.onClick?.()

    expect(onSkip).toHaveBeenCalledWith('tasks')
    expect(onNext).toHaveBeenCalledTimes(1)
  })

  it('renders configured step action labels and wires them through the action callback', () => {
    const onStepAction = vi.fn()
    const primaryAction = { kind: 'split-terminal-pane' as const, label: 'Split terminal' }
    const secondaryAction = { kind: 'next' as const, label: 'Skip' }
    const element = renderSurface(
      {
        primaryAction,
        secondaryAction
      },
      { onStepAction }
    )

    findElementByText(element, 'Split terminal')?.props.onClick?.()
    findElementByText(element, 'Skip')?.props.onClick?.()

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
    expect(panel.querySelector).toHaveBeenCalledWith(
      'button[aria-label^="Skip"], button[aria-label="Dismiss tour"]'
    )
    expect(click).toHaveBeenCalledTimes(1)
    expect(dismissContextualTour).not.toHaveBeenCalled()
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
