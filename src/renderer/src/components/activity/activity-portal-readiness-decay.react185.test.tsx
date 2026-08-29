/** @vitest-environment happy-dom */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useActivityTerminalPortalStatus } from './ActivityPrototypePage'
import {
  ACTIVITY_PORTAL_READINESS_BURST_WINDOW_MS,
  ACTIVITY_PORTAL_READINESS_MAX_FLIPS
} from './activity-portal-readiness-oscillation'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TAB_ID = 'tab-readiness-decay'
const LEAF_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const LEAF_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
const PANE_KEY = `${TAB_ID}:${LEAF_A}`

let root: Root

beforeEach(() => vi.useFakeTimers())

afterEach(() => {
  act(() => root?.unmount())
  vi.useRealTimers()
  vi.unstubAllGlobals()
  document.body.replaceChildren()
})

function installControllers(): { flushFrame: () => Promise<void>; notify: () => void } {
  let frame: FrameRequestCallback | null = null
  const observers = new Map<MutationObserver, MutationCallback>()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frame = callback
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', () => {
    frame = null
  })
  class ControlledMutationObserver implements MutationObserver {
    constructor(callback: MutationCallback) {
      observers.set(this, callback)
    }
    observe(): void {}
    disconnect(): void {
      observers.delete(this)
    }
    takeRecords(): MutationRecord[] {
      return []
    }
  }
  vi.stubGlobal('MutationObserver', ControlledMutationObserver)
  return {
    async flushFrame() {
      const callback = frame
      frame = null
      await act(async () => callback?.(performance.now()))
    },
    notify() {
      for (const [observer, callback] of observers) {
        callback([], observer)
      }
    }
  }
}

function renderPortalDom(target: HTMLElement, loading: boolean): void {
  const tabRoot = document.createElement('div')
  tabRoot.dataset.terminalTabId = TAB_ID
  for (const leafId of loading ? [LEAF_A, LEAF_B] : [LEAF_B]) {
    const pane = document.createElement('div')
    pane.dataset.leafId = leafId
    pane.dataset.ptyId = `pty-${leafId}`
    pane.appendChild(Object.assign(document.createElement('div'), { className: 'xterm-screen' }))
    Object.defineProperty(pane, 'getClientRects', { value: () => [{}] })
    tabRoot.appendChild(pane)
  }
  target.replaceChildren(tabRoot)
}

describe('Activity portal readiness latch decay', () => {
  it('rechecks a quiet loading pane when the burst window expires', async () => {
    const controls = installControllers()
    const target = document.createElement('div')
    document.body.append(target)
    renderPortalDom(target, false)
    let status = 'loading'

    function PortalStatus(): null {
      status = useActivityTerminalPortalStatus(target, PANE_KEY)
      return null
    }

    root = createRoot(document.createElement('div'))
    act(() => root.render(<PortalStatus />))
    await controls.flushFrame()

    for (let flip = 0; flip < ACTIVITY_PORTAL_READINESS_MAX_FLIPS * 2; flip += 1) {
      renderPortalDom(target, flip % 2 === 0)
      controls.notify()
      await controls.flushFrame()
    }
    renderPortalDom(target, true)
    controls.notify()
    await controls.flushFrame()
    expect(status).toBe('unavailable')

    act(() => vi.advanceTimersByTime(ACTIVITY_PORTAL_READINESS_BURST_WINDOW_MS))
    await controls.flushFrame()
    expect(status).toBe('loading')
  })
})
