// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppStore } from '@/store'
import { ContextualTourOverlay } from './ContextualTourOverlay'
import { advanceAgentSessionsTourPastNewTab } from './agent-sessions-tour-new-tab'

import { useContextualTour } from './use-contextual-tour'

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

describe('agent sessions tour progression', () => {
  it('continues to Add Project when switching onto an already completed chat split', async () => {
    tourTarget('terminal-pane-split-target', 150)
    tourTarget('chat-pane-split-target', 180)
    tourTarget('project-add-control', 250)
    tourTarget('workspace-create-control', 300)
    useAppStore.setState({
      persistedUIReady: true,
      activeContextualTourId: 'workspace-agent-sessions',
      activeContextualTourStepIndex: 2,
      activeTabType: 'terminal',
      featureInteractions: { 'tab-splits': { firstInteractedAt: 1, interactionCount: 1 } },
      contextualToursSeenIds: [],
      activeModal: 'none',
      contextualToursOnboardingVisible: false,
      contextualToursBlockingSurfaceVisible: false,
      activeContextualTourSuppressed: false
    })
    act(() => root.render(<ContextualTourOverlay />))
    await settle(50)
    expect(container.querySelector('[data-contextual-tour-panel]')).not.toBeNull()
    expect(useAppStore.getState().activeContextualTourStepIndex).toBe(2)

    act(() => useAppStore.setState({ activeTabType: 'agent-session' }))
    await settle(50)
    expect(container.querySelector('[data-contextual-tour-panel]')).not.toBeNull()
    expect(useAppStore.getState().activeContextualTourStepIndex).toBe(3)
    expect(useAppStore.getState().contextualToursSeenIds).not.toContain('workspace-agent-sessions')
  })

  it.each([
    ['agent-session', 'terminal'],
    ['terminal', 'agent-session']
  ] as const)('keeps the tour when the + menu changes %s to %s', async (before, after) => {
    tourTarget('tab-create-menu', 50)
    tourTarget('workspace-agent-terminal-tip', 150)
    tourTarget('project-add-control', 250)
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

    act(() => advanceAgentSessionsTourPastNewTab())
    await settle(50)
    target.dataset.activeContentType = after
    act(() => useAppStore.setState({ activeTabType: after }))
    await settle(50)

    const state = useAppStore.getState()
    expect(state.activeContextualTourId).toBe('workspace-agent-sessions')
    expect(state.activeContextualTourStepIndex).toBe(after === 'agent-session' ? 1 : 2)
    await act(async () => {
      await state.recordFeatureInteraction(
        after === 'agent-session' ? 'tab-splits' : 'terminal-pane-split'
      )
    })
    expect(useAppStore.getState().activeContextualTourStepIndex).toBe(3)
    await act(async () => {
      await useAppStore.getState().recordFeatureInteraction('project-add-introduction')
    })
    expect(useAppStore.getState().activeContextualTourStepIndex).toBe(4)
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
