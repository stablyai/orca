/** @vitest-environment happy-dom */
import { act, useLayoutEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { useActivityTerminalPortalStatus } from './activity-terminal-portal-status'
import type { ActivityPortalThreadRef } from './activity-portal-thread-reconciliation'
import {
  ACTIVITY_PORTAL_READINESS_MAX_FLIPS,
  type ActivityPortalReadinessStatus
} from './activity-portal-readiness-oscillation'

// Ready resets the flip latch, so retries need an independent budget unrelated to ACTIVITY_PORTAL_READINESS_MAX_FLIPS.
const PORTAL_READY_REAPPLY_ATTEMPTS = 32

const WORKTREE_ID = 'wt-1'
const TAB_ID = 'tab-react185'
const LEAF_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const LEAF_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'

const thread = (tabId: string, leafId: string): ActivityPortalThreadRef => ({
  paneKey: `${tabId}:${leafId}`,
  worktree: { id: WORKTREE_ID },
  tab: { id: tabId }
})

// Same-tab panes share one TerminalPane and swap via isolatedPaneKey.
const PANE_A = thread(TAB_ID, LEAF_A)

let root: Root

// Freeze Date only so CI load cannot expire the flip window; controllers still drive timers/rAF.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
})

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  vi.useRealTimers()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
})

function installAnimationFrameController(): {
  flush: () => Promise<void>
  pending: () => number
} {
  let nextFrameId = 1
  const callbacks = new Map<number, FrameRequestCallback>()
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    const frameId = nextFrameId
    nextFrameId += 1
    callbacks.set(frameId, callback)
    return frameId
  })
  vi.stubGlobal('cancelAnimationFrame', (frameId: number): void => {
    callbacks.delete(frameId)
  })
  return {
    async flush() {
      const queued = Array.from(callbacks.values())
      callbacks.clear()
      await act(async () => {
        for (const callback of queued) {
          callback(performance.now())
        }
        await Promise.resolve()
      })
    },
    pending: () => callbacks.size
  }
}

function installMutationObserverController(): { notify: () => void } {
  const callbacks = new Map<MutationObserver, MutationCallback>()
  class ControlledMutationObserver implements MutationObserver {
    constructor(callback: MutationCallback) {
      callbacks.set(this, callback)
    }

    observe(): void {}

    disconnect(): void {
      callbacks.delete(this)
    }

    takeRecords(): MutationRecord[] {
      return []
    }
  }
  vi.stubGlobal('MutationObserver', ControlledMutationObserver)
  return {
    notify() {
      for (const [observer, callback] of callbacks) {
        callback([], observer)
      }
    }
  }
}

async function flushPortalFramesUntil(
  frames: ReturnType<typeof installAnimationFrameController>,
  settled: () => boolean
): Promise<void> {
  for (let frame = 0; frame < 4 && !settled(); frame += 1) {
    await frames.flush()
  }
}

// Drain observer microtasks/readiness frames; report settlement before callers inspect transitions.
async function flushPortalReadiness(
  frames: ReturnType<typeof installAnimationFrameController>
): Promise<boolean> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await act(async () => {
      await Promise.resolve()
    })
    if (frames.pending() === 0) {
      await act(async () => {
        await Promise.resolve()
      })
      if (frames.pending() === 0) {
        return true
      }
    }
    await frames.flush()
  }
  return frames.pending() === 0
}

describe('Activity portal pane switching', () => {
  // Drive the latch through production wiring because React's nested-update limit is root-wide.
  it('bounds a readiness oscillation driven through the real portal-status hook', async () => {
    const frames = installAnimationFrameController()
    const target = document.createElement('div')
    document.body.append(target)
    // Alternate hidden and ambiguous DOM states so ready remains unreachable.
    const buildRoot = (hiddenLeafId: string | null): void => {
      const tabRoot = document.createElement('div')
      tabRoot.dataset.terminalTabId = TAB_ID
      for (const leafId of [LEAF_A, LEAF_B]) {
        const pane = document.createElement('div')
        pane.dataset.leafId = leafId
        pane.setAttribute('data-pty-id', `pty-${leafId}`)
        pane.appendChild(
          Object.assign(document.createElement('div'), { className: 'xterm-screen' })
        )
        if (leafId === hiddenLeafId) {
          pane.style.display = 'none'
        }
        Object.defineProperty(pane, 'getClientRects', { value: () => [{}], configurable: true })
        tabRoot.appendChild(pane)
      }
      target.replaceChildren(tabRoot)
    }
    buildRoot(LEAF_A)

    let renders = 0
    const statuses: ActivityPortalReadinessStatus[] = []
    // Stop feeding an unlatched spin so failure is immediate and legible.
    const RENDER_CAP = 50

    function ActivityTerminalSlot(): null {
      renders += 1
      const status = useActivityTerminalPortalStatus(target, PANE_A.paneKey)
      statuses.push(status)
      // Reapply opposite isolation so MutationObserver reports opposite readiness.
      useLayoutEffect(() => {
        if (renders > RENDER_CAP) {
          return
        }
        if (status === 'unavailable') {
          buildRoot(null)
        } else if (status === 'loading') {
          buildRoot(LEAF_A)
        }
      })
      return null
    }

    root = createRoot(document.createElement('div'))
    await act(async () => {
      root.render(<ActivityTerminalSlot />)
    })
    for (let frame = 0; frame < 20 && frames.pending() > 0; frame += 1) {
      await frames.flush()
    }
    const settledRenders = renders
    await frames.flush()

    expect(renders).toBeLessThanOrEqual(RENDER_CAP)
    expect(renders).toBe(settledRenders)
    expect(frames.pending()).toBe(0)
    expect(statuses.at(-1)).toBe('unavailable')
  })

  it('releases a latched readiness once the terminal attaches', async () => {
    const frames = installAnimationFrameController()
    const mutations = installMutationObserverController()
    const target = document.createElement('div')
    document.body.append(target)
    const buildRoot = (mode: 'hidden' | 'sibling' | 'ready'): void => {
      const tabRoot = document.createElement('div')
      tabRoot.dataset.terminalTabId = TAB_ID
      for (const leafId of [LEAF_A, LEAF_B]) {
        const pane = document.createElement('div')
        pane.dataset.leafId = leafId
        pane.setAttribute('data-pty-id', `pty-${leafId}`)
        pane.appendChild(
          Object.assign(document.createElement('div'), { className: 'xterm-screen' })
        )
        if (mode === 'hidden' && leafId === LEAF_A) {
          pane.style.display = 'none'
        }
        if (mode === 'ready' && leafId === LEAF_B) {
          pane.style.display = 'none'
        }
        Object.defineProperty(pane, 'getClientRects', { value: () => [{}], configurable: true })
        tabRoot.appendChild(pane)
      }
      target.replaceChildren(tabRoot)
    }
    buildRoot('hidden')

    const statuses: ActivityPortalReadinessStatus[] = []

    function ActivityTerminalSlot(): null {
      const status = useActivityTerminalPortalStatus(target, PANE_A.paneKey)
      statuses.push(status)
      return null
    }

    root = createRoot(document.createElement('div'))
    await act(async () => {
      root.render(<ActivityTerminalSlot />)
    })
    expect(await flushPortalReadiness(frames)).toBe(true)
    await flushPortalFramesUntil(frames, () => statuses.at(-1) === 'unavailable')
    expect(statuses.at(-1)).toBe('unavailable')

    // Feed DOM states until sibling loading latches unavailable; CI may coalesce mutations below the flip limit.
    let sawSiblingLoading = false
    let sawLatchedSibling = false
    for (
      let flip = 0;
      flip < ACTIVITY_PORTAL_READINESS_MAX_FLIPS * 4 && !sawLatchedSibling;
      flip += 1
    ) {
      const mode = flip % 2 === 0 ? 'sibling' : 'hidden'
      const statusesBefore = statuses.length
      await act(async () => {
        buildRoot(mode)
        mutations.notify()
      })
      expect(await flushPortalReadiness(frames)).toBe(true)
      if (mode !== 'sibling') {
        continue
      }
      // Prove the latch on a sibling transition that formerly emitted loading, rather than on a missing leaf.
      if (statuses.slice(statusesBefore).includes('loading')) {
        sawSiblingLoading = true
      } else if (sawSiblingLoading && statuses.at(-1) === 'unavailable') {
        sawLatchedSibling = true
      }
    }
    expect(sawLatchedSibling).toBe(true)
    expect(statuses.at(-1)).toBe('unavailable')

    // CI may coalesce a replacement; reapply ready DOM until attach is observed.
    let sawReady = false
    for (let attempt = 0; attempt < PORTAL_READY_REAPPLY_ATTEMPTS && !sawReady; attempt += 1) {
      await act(async () => {
        buildRoot('ready')
        mutations.notify()
      })
      expect(await flushPortalReadiness(frames)).toBe(true)
      await flushPortalFramesUntil(frames, () => statuses.at(-1) === 'ready')
      sawReady = statuses.at(-1) === 'ready'
    }
    expect(statuses.at(-1)).toBe('ready')
  })
})
