// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ContextualTourOverlay } from './ContextualTourOverlay'
import { useAppStore } from '@/store'

let container: HTMLDivElement
let root: Root

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
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

async function setDocumentVisibility(state: 'visible' | 'hidden'): Promise<void> {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function ringsTop(): string | undefined {
  return container.querySelector<HTMLElement>('[data-contextual-tour-target-rings]')?.style.top
}

beforeEach(async () => {
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
  useAppStore.setState({ activeContextualTourId: null, activeContextualTourStepIndex: 0 })
})

describe('ContextualTourOverlay full-pass interval visibility gate', () => {
  it('pauses the 500ms full pass while hidden and re-measures on return', async () => {
    const target = tourTarget('workspace-create-control', 300)
    useAppStore.setState({
      activeContextualTourId: 'workspace-agent-sessions',
      activeContextualTourStepIndex: 1,
      activeModal: 'none',
      contextualToursOnboardingVisible: false,
      contextualToursBlockingSurfaceVisible: false,
      activeContextualTourSuppressed: false
    })
    await act(async () => {
      root.render(<ContextualTourOverlay />)
      await new Promise((resolve) => setTimeout(resolve, 50))
    })
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
