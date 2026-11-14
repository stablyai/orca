// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { useAppStore } from '@/store'

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
