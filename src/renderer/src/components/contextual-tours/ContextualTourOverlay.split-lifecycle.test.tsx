// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ContextualTourOverlay } from './ContextualTourOverlay'
import { useContextualTour } from './use-contextual-tour'
import { useAppStore } from '@/store'

let container: HTMLDivElement
let root: Root

function TourSurfaces({ terminal, tasks }: { terminal: boolean; tasks: boolean }): null {
  useContextualTour('workspace-agent-sessions', terminal, 'workspace_agent_sessions_visible')
  useContextualTour('tasks', tasks, 'tasks_open')
  return null
}

// Mounted only while a tour is active, as the app root does, so nothing survives a pause in the overlay.
function ActiveTourOverlay(): React.JSX.Element | null {
  const activeTourId = useAppStore((s) => s.activeContextualTourId)
  return activeTourId ? <ContextualTourOverlay /> : null
}

function renderSurfaces(surfaces: { terminal: boolean; tasks: boolean }): void {
  act(() => {
    root.render(
      <>
        <TourSurfaces {...surfaces} />
        <ActiveTourOverlay />
      </>
    )
  })
}

function addTourTarget(name: string, top: number): HTMLElement {
  const element = document.createElement('div')
  element.setAttribute('data-contextual-tour-target', name)
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ left: 100, right: 220, top, bottom: top + 40, width: 120, height: 40 })
  })
  document.body.appendChild(element)
  return element
}

async function settle(ms = 1_000): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

function shownTip(): string | null {
  return container.querySelector('[data-contextual-tour-panel] h2')?.textContent ?? null
}

async function interruptWithDialog(): Promise<void> {
  act(() => {
    useAppStore.setState({ activeModal: 'add-repo' })
  })
  await settle()
  expect(shownTip()).toBeNull()
}

async function closeDialog(): Promise<void> {
  act(() => {
    useAppStore.setState({ activeModal: 'none' })
  })
  await settle()
}

beforeEach(() => {
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
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.stubGlobal('api', {
    ui: {
      set: () => Promise.resolve(),
      recordFeatureInteraction: () =>
        Promise.resolve({ featureInteractions: {}, contextualToursSeenIds: [] })
    }
  })
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 960 })
  useAppStore.setState({
    persistedUIReady: true,
    contextualToursAutoEligible: true,
    contextualToursSeenIds: [],
    contextualTourSessionTourId: null,
    featureInteractions: {},
    activeModal: 'none',
    sidebarOpen: true,
    contextualToursOnboardingVisible: false,
    contextualToursBlockingSurfaceVisible: false,
    activeContextualTourId: null,
    activeContextualTourStepIndex: 0,
    activeContextualTourSuppressed: false
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  addTourTarget('terminal-pane-split-target', 200)
  addTourTarget('workspace-create-control', 40)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.querySelectorAll('[data-contextual-tour-target]').forEach((node) => node.remove())
  useAppStore.setState({ activeContextualTourId: null, activeContextualTourStepIndex: 0 })
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('Split a terminal pane tip lifecycle', () => {
  it('returns by itself after a dialog and after visiting another page', async () => {
    const terminalInput = document.createElement('textarea')
    document.body.appendChild(terminalInput)
    terminalInput.focus()
    renderSurfaces({ terminal: true, tasks: false })
    await settle()
    expect(shownTip()).toBe('Split a terminal pane')
    // The tip shows over the terminal the user types into; it never takes focus, first time included.
    expect(document.activeElement).toBe(terminalInput)

    await interruptWithDialog()
    terminalInput.focus()
    await closeDialog()
    expect(shownTip()).toBe('Split a terminal pane')
    // Typing that resumes in the terminal must not land on the returning tip's dismiss button.
    expect(document.activeElement).toBe(terminalInput)
    terminalInput.remove()

    // Another page's tips still show while Split is unfinished, and Split comes back afterwards.
    const tasksTarget = addTourTarget('tasks-source-filters', 300)
    renderSurfaces({ terminal: false, tasks: true })
    await settle()
    expect(shownTip()).toBe('Choose the work source')

    tasksTarget.remove()
    renderSurfaces({ terminal: true, tasks: false })
    await settle()
    expect(shownTip()).toBe('Split a terminal pane')
    expect(useAppStore.getState().contextualToursSeenIds).not.toContain('workspace-agent-sessions')
  })

  it('shows the next tip after a split that finished while the tip was paused', async () => {
    renderSurfaces({ terminal: true, tasks: false })
    await settle()
    await interruptWithDialog()

    const terminalInput = document.createElement('textarea')
    document.body.appendChild(terminalInput)
    terminalInput.focus()
    act(() => {
      void useAppStore.getState().recordFeatureInteraction('terminal-pane-split')
    })
    await closeDialog()
    expect(shownTip()).toBe('Start another task in parallel')
    expect(document.activeElement).toBe(terminalInput)
    expect(useAppStore.getState().contextualToursSeenIds).toContain('workspace-agent-sessions')
    terminalInput.remove()
  })

  it('moves to the next tip after a keyboard split without taking the terminal focus', async () => {
    const terminalInput = document.createElement('textarea')
    document.body.appendChild(terminalInput)
    terminalInput.focus()
    renderSurfaces({ terminal: true, tasks: false })
    await settle()

    act(() => {
      void useAppStore.getState().recordFeatureInteraction('terminal-pane-split')
    })
    await settle()
    expect(shownTip()).toBe('Start another task in parallel')
    expect(document.activeElement).toBe(terminalInput)
    terminalInput.remove()

    // Navigating inside the callout keeps focus in it once its button is replaced.
    act(() => {
      const back = Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find(
        (button) => button.textContent?.includes('Back')
      )
      back?.focus()
      back?.click()
    })
    await settle()
    expect(shownTip()).toBe('Split a terminal pane')
    expect(
      container.querySelector('[data-contextual-tour-panel]')?.contains(document.activeElement)
    ).toBe(true)
  })

  it('keeps the next tip owed when its target is missing right after the split', async () => {
    renderSurfaces({ terminal: true, tasks: false })
    await settle()
    document.querySelector('[data-contextual-tour-target="workspace-create-control"]')?.remove()

    act(() => {
      void useAppStore.getState().recordFeatureInteraction('terminal-pane-split')
    })
    await settle()
    expect(shownTip()).toBeNull()
    expect(useAppStore.getState().contextualToursSeenIds).not.toContain('workspace-agent-sessions')

    const tasksTarget = addTourTarget('tasks-source-filters', 300)
    renderSurfaces({ terminal: false, tasks: true })
    await settle()
    expect(shownTip()).toBe('Choose the work source')

    tasksTarget.remove()
    renderSurfaces({ terminal: true, tasks: false })
    addTourTarget('workspace-create-control', 40)
    await settle()
    expect(shownTip()).toBe('Start another task in parallel')
  })

  it('opens the sidebar for the next tip when the split finished while paused', async () => {
    act(() => {
      useAppStore.setState({ sidebarOpen: false })
    })
    document.querySelector('[data-contextual-tour-target="workspace-create-control"]')?.remove()
    renderSurfaces({ terminal: true, tasks: false })
    await settle()
    expect(shownTip()).toBe('Split a terminal pane')
    await interruptWithDialog()

    act(() => {
      void useAppStore.getState().recordFeatureInteraction('terminal-pane-split')
    })
    expect(useAppStore.getState().sidebarOpen).toBe(true)
    addTourTarget('workspace-create-control', 40)
    await closeDialog()
    expect(shownTip()).toBe('Start another task in parallel')
  })

  it('keeps its place and focus when a forced tour shows while it is paused', async () => {
    act(() => {
      useAppStore.setState({ sidebarOpen: false })
    })
    document.querySelector('[data-contextual-tour-target="workspace-create-control"]')?.remove()
    renderSurfaces({ terminal: true, tasks: false })
    await settle()
    expect(shownTip()).toBe('Split a terminal pane')
    const terminalInput = document.createElement('textarea')
    document.body.appendChild(terminalInput)
    renderSurfaces({ terminal: false, tasks: false })
    await settle()
    terminalInput.focus()

    const browserTarget = addTourTarget('client-hosted-browser-controls', 300)
    act(() => {
      useAppStore
        .getState()
        .requestContextualTour('client-hosted-browser', 'client_hosted_browser_visible', false, {
          force: true
        })
    })
    await settle()
    expect(shownTip()).toBe('This page renders on your desktop')
    act(() => {
      void useAppStore.getState().recordFeatureInteraction('terminal-pane-split')
    })
    expect(useAppStore.getState().sidebarOpen).toBe(true)
    act(() => {
      container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss tour"]')?.click()
    })
    await settle()
    browserTarget.remove()
    terminalInput.focus()

    addTourTarget('workspace-create-control', 40)
    renderSurfaces({ terminal: true, tasks: false })
    await settle()
    expect(shownTip()).toBe('Start another task in parallel')
    expect(document.activeElement).toBe(terminalInput)
    terminalInput.remove()
  })

  it('stays closed after the user dismisses it', async () => {
    renderSurfaces({ terminal: true, tasks: false })
    await settle()

    act(() => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Skip tour"], button[aria-label="Dismiss tour"]'
        )
        ?.click()
    })
    await settle()
    await closeDialog()
    expect(shownTip()).toBeNull()
    expect(useAppStore.getState().contextualToursSeenIds).toContain('workspace-agent-sessions')
  })
})
