// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ContextualTourOverlay } from './ContextualTourOverlay'
import { useAppStore } from '@/store'
import { getContextualTourStepIndex } from '../../../../shared/contextual-tours'
import { advanceAgentSessionsTourPastNewTab } from './agent-sessions-tour-new-tab'
import { useContextualTour } from './use-contextual-tour'

const PARALLEL_STEP_INDEX = getContextualTourStepIndex(
  'workspace-agent-sessions',
  'agent-sessions-parallel'
)

let container: HTMLDivElement
let root: Root
const initialState = useAppStore.getState()

function tourTarget(name: string, top: number): { moveTo: (top: number) => void } {
  let currentTop = top
  const element = document.createElement('div')
  element.setAttribute('data-contextual-tour-target', name)
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({
      left: 100,
      right: 220,
      top: currentTop,
      bottom: currentTop + 40,
      width: 120,
      height: 40,
      x: 100,
      y: currentTop
    })
  })
  document.body.appendChild(element)
  return {
    moveTo: (next) => {
      currentTop = next
    }
  }
}

async function settle(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

async function setDocumentVisibility(state: 'visible' | 'hidden'): Promise<void> {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
  })
}

function ringsTop(): string | undefined {
  return container.querySelector<HTMLElement>('[data-contextual-tour-target-rings]')?.style.top
}

beforeEach(async () => {
  useAppStore.setState(initialState, true)
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'requestAnimationFrame',
      'cancelAnimationFrame'
    ]
  })
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;(window as unknown as { api: unknown }).api = { ui: { set: () => Promise.resolve() } }
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 960 })
  await setDocumentVisibility('visible')
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  act(() => root.unmount())
  container.remove()
  document.querySelectorAll('[data-contextual-tour-target]').forEach((node) => node.remove())
  await setDocumentVisibility('visible')
  useAppStore.setState(initialState, true)
  vi.useRealTimers()
})

describe('ContextualTourOverlay full-pass interval visibility gate', () => {
  it('keeps focus in a popup when the underlying tour ends', async () => {
    tourTarget('workspace-create-control', 300)
    const originalInput = document.createElement('input')
    document
      .querySelector('[data-contextual-tour-target="workspace-create-control"]')
      ?.appendChild(originalInput)
    originalInput.focus()
    useAppStore.setState({
      activeContextualTourId: 'workspace-agent-sessions',
      activeContextualTourStepIndex: PARALLEL_STEP_INDEX,
      activeModal: 'none',
      contextualToursOnboardingVisible: false,
      contextualToursBlockingSurfaceVisible: false,
      activeContextualTourSuppressed: false
    })
    act(() => root.render(<ContextualTourOverlay />))
    await settle(50)
    tourTarget('test-popup', 400)
    const popup = document.querySelector('[data-contextual-tour-target="test-popup"]')
    if (!popup) {
      throw new Error('Missing popup')
    }
    popup.setAttribute('role', 'menu')
    const popupInput = document.createElement('input')
    popup.appendChild(popupInput)
    popupInput.focus()

    act(() => useAppStore.getState().cancelContextualTour('workspace-agent-sessions'))
    await settle(50)

    expect(document.activeElement).toBe(popupInput)
  })

  it.each(['terminal', 'agent-session'] as const)(
    'waits for a delayed %s pane instead of skipping the split lesson',
    async (type) => {
      tourTarget('tab-create-menu', 50)
      tourTarget('workspace-create-control', 300)
      useAppStore.setState({
        activeContextualTourId: 'workspace-agent-sessions',
        activeContextualTourStepIndex: 0,
        activeTabType: type,
        activeModal: 'none',
        contextualToursOnboardingVisible: false,
        contextualToursBlockingSurfaceVisible: false,
        activeContextualTourSuppressed: false
      })
      act(() => root.render(<ContextualTourOverlay />))
      await settle(50)

      act(() => advanceAgentSessionsTourPastNewTab())
      await settle(1_100)

      expect(useAppStore.getState().activeContextualTourStepIndex).not.toBe(PARALLEL_STEP_INDEX)
      expect(container.querySelector('[data-contextual-tour-panel]')).toBeNull()

      tourTarget(type === 'terminal' ? 'terminal-pane-split-target' : 'chat-pane-split-target', 150)
      await settle(550)

      expect(container.querySelector('[data-contextual-tour-panel]')?.textContent).toContain(
        type === 'terminal' ? 'Split a terminal pane' : 'Run two chats side by side'
      )

      document
        .querySelectorAll(
          '[data-contextual-tour-target="terminal-pane-split-target"], [data-contextual-tour-target="chat-pane-split-target"]'
        )
        .forEach((target) => target.remove())
      act(() =>
        useAppStore.setState({ activeTabType: type === 'terminal' ? 'agent-session' : 'terminal' })
      )
      await settle(1_100)

      expect(useAppStore.getState().activeContextualTourStepIndex).not.toBe(PARALLEL_STEP_INDEX)
      expect(container.querySelector('[data-contextual-tour-panel]')).toBeNull()

      tourTarget(type === 'terminal' ? 'chat-pane-split-target' : 'terminal-pane-split-target', 150)
      await settle(550)
      expect(container.querySelector('[data-contextual-tour-panel]')?.textContent).toContain(
        type === 'terminal' ? 'Run two chats side by side' : 'Split a terminal pane'
      )
    }
  )

  it('hides the previous browser lesson while waiting for its menu target', async () => {
    tourTarget('browser-grab-control', 50)
    tourTarget('browser-annotation-control', 150)
    useAppStore.setState({
      activeContextualTourId: 'browser',
      activeContextualTourStepIndex: 1,
      activeModal: 'none',
      contextualToursOnboardingVisible: false,
      contextualToursBlockingSurfaceVisible: false,
      activeContextualTourSuppressed: false
    })
    act(() => root.render(<ContextualTourOverlay />))
    await settle(50)
    expect(container.querySelector('[data-contextual-tour-panel]')?.textContent).toContain(
      'Mark design feedback in place'
    )

    act(() => useAppStore.getState().advanceContextualTour())
    await settle(50)

    expect(useAppStore.getState().activeContextualTourId).toBe('browser')
    expect(useAppStore.getState().activeContextualTourStepIndex).toBe(2)
    expect(container.querySelector('[data-contextual-tour-panel]')).toBeNull()

    tourTarget('browser-import-cookies-control', 250)
    await settle(550)

    expect(container.querySelector('[data-contextual-tour-panel]')?.textContent).toContain(
      'Stay logged in'
    )
  })

  it.each([
    ['agent-session', 'terminal'],
    ['terminal', 'agent-session']
  ] as const)('keeps the tour when the + menu changes %s to %s', async (before, after) => {
    tourTarget('tab-create-menu', 50)
    tourTarget('workspace-agent-terminal-tip', 150)
    tourTarget('workspace-create-control', 300)
    const target = document.querySelector<HTMLElement>(
      '[data-contextual-tour-target="workspace-agent-terminal-tip"]'
    )
    if (!target) {
      throw new Error('Missing workspace tour target')
    }
    target.dataset.activeContentType = before
    useAppStore.setState({
      activeContextualTourId: 'workspace-agent-sessions',
      activeContextualTourStepIndex: 0,
      activeTabType: before,
      contextualToursSeenIds: [],
      activeModal: 'none',
      contextualToursOnboardingVisible: false,
      contextualToursBlockingSurfaceVisible: false,
      activeContextualTourSuppressed: false,
      persistedUIReady: true
    })
    act(() => root.render(<ContextualTourOverlay />))
    await settle(50)
    expect(useAppStore.getState().contextualToursSeenIds).toContain('workspace-agent-sessions')

    act(() => advanceAgentSessionsTourPastNewTab())
    await settle(50)
    target.dataset.activeContentType = after
    act(() => useAppStore.setState({ activeTabType: after }))
    await settle(50)

    const state = useAppStore.getState()
    expect(state.activeContextualTourId).toBe('workspace-agent-sessions')
    expect(state.activeContextualTourStepIndex).toBe(
      getContextualTourStepIndex(
        'workspace-agent-sessions',
        after === 'agent-session' ? 'agent-sessions-split-chat' : 'agent-sessions-split'
      )
    )
    await act(async () => {
      await state.recordFeatureInteraction(
        after === 'agent-session' ? 'tab-splits' : 'terminal-pane-split'
      )
    })
    expect(useAppStore.getState().activeContextualTourStepIndex).toBe(PARALLEL_STEP_INDEX)
  })

  it('pauses the 500ms full pass while hidden and re-measures on return', async () => {
    const target = tourTarget('workspace-create-control', 300)
    useAppStore.setState({
      activeContextualTourId: 'workspace-agent-sessions',
      activeContextualTourStepIndex: PARALLEL_STEP_INDEX,
      activeModal: 'none',
      contextualToursOnboardingVisible: false,
      contextualToursBlockingSurfaceVisible: false,
      activeContextualTourSuppressed: false
    })
    act(() => {
      root.render(<ContextualTourOverlay />)
    })
    await settle(50)
    expect(ringsTop()).toBe('300px')

    // Baseline: while visible, the periodic full pass follows a silent move.
    target.moveTo(640)
    await settle(700)
    expect(ringsTop()).toBe('640px')

    await setDocumentVisibility('hidden')
    target.moveTo(900)
    await settle(1_500)
    expect(ringsTop()).toBe('640px')

    // Returning runs the pass immediately, so the overlay is never left stale.
    await setDocumentVisibility('visible')
    await settle(50)
    expect(ringsTop()).toBe('900px')
  })
})

function PendingTourSource({ persisted }: { persisted: Promise<void> }) {
  useContextualTour('tasks', true, 'tasks_open', {
    recordFeatureInteraction: false,
    featureInteractionPersisted: persisted
  })
  return null
}

it('does not start a tour after its source unmounts between persistence and the queued request', async () => {
  let resolvePersisted!: () => void
  const persisted = new Promise<void>((resolve) => {
    resolvePersisted = resolve
  })
  tourTarget('tasks-source-filters', 50)
  useAppStore.setState({
    persistedUIReady: true,
    contextualToursAutoEligible: true,
    contextualToursSeenIds: [],
    contextualTourShownThisSession: false,
    activeContextualTourId: null,
    activeModal: 'none',
    contextualToursOnboardingVisible: false,
    contextualToursBlockingSurfaceVisible: false
  })
  act(() => root.render(<PendingTourSource persisted={persisted} />))

  resolvePersisted()
  await Promise.resolve()
  act(() => root.unmount())
  await settle(50)

  expect(useAppStore.getState().activeContextualTourId).toBeNull()
})
