// @vitest-environment happy-dom

import { act, Profiler } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ContextualTourOverlay } from './ContextualTourOverlay'
import { useAppStore } from '@/store'

let container: HTMLDivElement
let root: Root
let commits = 0

type MovableTarget = { element: HTMLElement; moveTo: (top: number) => void }

function tourTarget(name: string, top: number): MovableTarget {
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
    element,
    moveTo: (next) => {
      currentTop = next
    }
  }
}

async function mountOverlay(): Promise<void> {
  await act(async () => {
    root.render(
      <Profiler
        id="contextual-tour"
        onRender={() => {
          commits += 1
        }}
      >
        <ContextualTourOverlay />
      </Profiler>
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
  })
}

// Why: one act() per event so React flushes between events the way the browser
// does, instead of coalescing a whole burst into a single render.
async function dispatchScroll(source: EventTarget): Promise<void> {
  await act(async () => {
    source.dispatchEvent(new Event('scroll'))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;(window as unknown as { api: unknown }).api = { ui: { set: () => Promise.resolve() } }
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 960 })
  commits = 0
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  document.querySelectorAll('[data-contextual-tour-target]').forEach((node) => node.remove())
  useAppStore.setState({ activeContextualTourId: null, activeContextualTourStepIndex: 0 })
})

describe('ContextualTourOverlay re-measure triggers', () => {
  it('does not re-render for scroll events that move nothing', async () => {
    tourTarget('workspace-create-control', 300)
    useAppStore.setState({
      activeContextualTourId: 'workspace-agent-sessions',
      activeContextualTourStepIndex: 1,
      activeModal: 'none',
      contextualToursOnboardingVisible: false,
      contextualToursBlockingSurfaceVisible: false,
      activeContextualTourSuppressed: false
    })
    await mountOverlay()
    expect(container.querySelector('[data-contextual-tour-target-rings]')).not.toBeNull()

    // A scrolling pane elsewhere in the app: the overlay's capture-phase window
    // listener sees every one of these even though nothing about the tour moved.
    const unrelatedPane = document.createElement('div')
    document.body.appendChild(unrelatedPane)
    const commitsBeforeScroll = commits
    for (let index = 0; index < 60; index += 1) {
      await dispatchScroll(unrelatedPane)
    }
    unrelatedPane.remove()

    expect(commits - commitsBeforeScroll).toBeLessThanOrEqual(2)
  })

  it('still follows the target when it actually moves', async () => {
    const target = tourTarget('workspace-create-control', 300)
    useAppStore.setState({
      activeContextualTourId: 'workspace-agent-sessions',
      activeContextualTourStepIndex: 1,
      activeModal: 'none',
      contextualToursOnboardingVisible: false,
      contextualToursBlockingSurfaceVisible: false,
      activeContextualTourSuppressed: false
    })
    await mountOverlay()

    const rings = (): HTMLElement | null =>
      container.querySelector<HTMLElement>('[data-contextual-tour-target-rings]')
    expect(rings()?.style.top).toBe('300px')

    target.moveTo(640)
    await dispatchScroll(window)

    expect(rings()?.style.top).toBe('640px')
  })
})
