/** @vitest-environment happy-dom */
import { act, useState } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useActivityTerminalPortalStatus } from './ActivityPrototypePage'
import { ACTIVITY_PORTAL_READINESS_MAX_FLIPS } from './activity-portal-readiness-oscillation'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const TAB_ID = 'tab-readiness-churn'
const OTHER_TAB_ID = 'tab-readiness-churn-other'
const LEAF_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const LEAF_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
const LEAF_C = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1'
const PANE_A = `${TAB_ID}:${LEAF_A}`
const PANE_B = `${TAB_ID}:${LEAF_B}`
const OTHER_PANE_B = `${OTHER_TAB_ID}:${LEAF_B}`

let root: Root

// Freeze Date (not timers/rAF, which still drive the readiness frames) so the latch's flip window is
// decided by the churn under test rather than by how slowly the machine runs it.
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
})

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  vi.useRealTimers()
  document.body.replaceChildren()
})

function buildNeverReadyRoot(target: HTMLElement, tabId: string = TAB_ID): void {
  const tabRoot = document.createElement('div')
  tabRoot.dataset.terminalTabId = tabId
  for (const leafId of [LEAF_A, LEAF_C]) {
    const pane = document.createElement('div')
    pane.dataset.leafId = leafId
    pane.setAttribute('data-pty-id', `pty-${leafId}`)
    pane.appendChild(Object.assign(document.createElement('div'), { className: 'xterm-screen' }))
    Object.defineProperty(pane, 'getClientRects', { value: () => [{}], configurable: true })
    tabRoot.appendChild(pane)
  }
  target.replaceChildren(tabRoot)
}

/** Lets the readiness rAF this churn step scheduled land in React state. */
async function drainReadinessFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })
}

describe('Activity portal readiness subscription churn', () => {
  // Why this bound matters: React raises #185 only after >50 *consecutive* commits that each leave a
  // pending sync/default lane; any commit that leaves none resets nestedUpdateCount. This pins the
  // reason the readiness subscription can never be that source -- its only writer is an rAF callback,
  // and the effect cleanup cancels that frame on every churn step, so a synchronous cascade of
  // subscription churn commits nothing at all. A #185 on this page must come from another setState.
  it('contributes no state updates to a synchronous churn cascade past React nested-update limit', () => {
    const target = document.createElement('div')
    buildNeverReadyRoot(target)
    document.body.append(target)

    let selectPane: (paneKey: string) => void = () => {}
    let readinessCommits = 0
    let lastStatus = 'loading'

    function ActivityTerminalSlot(): null {
      const [paneKey, setPaneKey] = useState(PANE_A)
      selectPane = setPaneKey
      const status = useActivityTerminalPortalStatus(target, paneKey)
      if (status !== lastStatus) {
        readinessCommits += 1
        lastStatus = status
      }
      return null
    }

    root = createRoot(document.createElement('div'))
    act(() => {
      root.render(<ActivityTerminalSlot />)
    })
    readinessCommits = 0

    act(() => {
      expect(() => {
        for (let index = 0; index < 60; index += 1) {
          flushSync(() => {
            selectPane(index % 2 === 0 ? PANE_B : PANE_A)
          })
        }
      }).not.toThrow()
    })
    expect(readinessCommits).toBe(0)
  })

  it('coalesces pane-key churn and commits the latest readiness', async () => {
    const target = document.createElement('div')
    buildNeverReadyRoot(target)
    document.body.append(target)

    let selectPane: (paneKey: string) => void = () => {}
    let renders = 0
    let status = 'loading'

    function ActivityTerminalSlot(): null {
      renders += 1
      const [paneKey, setPaneKey] = useState(PANE_A)
      selectPane = setPaneKey
      status = useActivityTerminalPortalStatus(target, paneKey)
      return null
    }

    root = createRoot(document.createElement('div'))
    act(() => {
      root.render(<ActivityTerminalSlot />)
    })

    act(() => {
      expect(() => {
        for (let index = 0; index < 29; index += 1) {
          flushSync(() => {
            selectPane(index % 2 === 0 ? PANE_B : PANE_A)
          })
        }
      }).not.toThrow()
    })
    expect(renders).toBeLessThanOrEqual(31)

    await act(async () => {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    })
    expect(status).toBe('unavailable')
    expect(renders).toBeLessThanOrEqual(32)
  })

  // Asserts the loop-terminating property, not just a final value: the status that drives the page's
  // swap effect (stagedPortalUnavailable) must stop alternating part-way through the churn and stay
  // put. While it alternates, every step re-targets both readiness subscriptions and re-stages.
  function expectReadinessStopsAlternating(statuses: string[]): void {
    // Sanity: the fixture really does alternate early, so the run below is the latch, not a rig.
    const head = statuses.slice(0, ACTIVITY_PORTAL_READINESS_MAX_FLIPS)
    expect(new Set(head)).toEqual(new Set(['loading', 'unavailable']))
    // Termination: the churn keeps flipping the DOM but the status the swap effect reads stops moving.
    const tail = statuses.slice(ACTIVITY_PORTAL_READINESS_MAX_FLIPS)
    expect(tail.length).toBeGreaterThan(20)
    expect(new Set(tail)).toEqual(new Set(['unavailable']))
  }

  // Why: staging only happens across tabs (reconcileActivityPortalThreads returns no stagedThread for
  // same-tab panes), so the production swap moves slot element, pane key AND tab id in lockstep --
  // every identity a subscription-scoped latch could key on.
  it('stops alternating readiness when the slot, pane key and tab id all churn together', async () => {
    const targets = [document.createElement('div'), document.createElement('div')]
    buildNeverReadyRoot(targets[0], TAB_ID)
    buildNeverReadyRoot(targets[1], OTHER_TAB_ID)
    for (const target of targets) {
      document.body.append(target)
    }

    let selectFlip: (flip: number) => void = () => {}
    let status = 'loading'
    const settledStatuses: string[] = []

    function ActivityTerminalSlot(): null {
      const [flip, setFlip] = useState(0)
      selectFlip = setFlip
      // Alternating panes report 'loading' (unisolated sibling) then 'unavailable' (missing leaf).
      status = useActivityTerminalPortalStatus(
        targets[flip % 2],
        flip % 2 === 0 ? PANE_A : OTHER_PANE_B
      )
      return null
    }

    root = createRoot(document.createElement('div'))
    act(() => {
      root.render(<ActivityTerminalSlot />)
    })

    for (let flip = 1; flip <= 40; flip += 1) {
      await act(async () => {
        selectFlip(flip)
      })
      await drainReadinessFrame()
      settledStatuses.push(status)
    }

    expectReadinessStopsAlternating(settledStatuses)
  })

  it('stops alternating readiness when only the pane key churns within one tab', async () => {
    const target = document.createElement('div')
    buildNeverReadyRoot(target, TAB_ID)
    document.body.append(target)

    let selectPane: (paneKey: string) => void = () => {}
    let status = 'loading'
    const settledStatuses: string[] = []

    function ActivityTerminalSlot(): null {
      const [paneKey, setPaneKey] = useState(PANE_A)
      selectPane = setPaneKey
      status = useActivityTerminalPortalStatus(target, paneKey)
      return null
    }

    root = createRoot(document.createElement('div'))
    act(() => {
      root.render(<ActivityTerminalSlot />)
    })

    for (let flip = 0; flip < 40; flip += 1) {
      await act(async () => {
        selectPane(flip % 2 === 0 ? PANE_B : PANE_A)
      })
      await drainReadinessFrame()
      settledStatuses.push(status)
    }

    expectReadinessStopsAlternating(settledStatuses)
  })

  // Why: the flip budget outlives the subscription, so a burst window wide enough to cover ordinary
  // clicking would let one user's thread-hopping answer 'unavailable' for the next healthy pane.
  it('does not answer for a later attaching pane after human-paced selections', async () => {
    const churnTarget = document.createElement('div')
    buildNeverReadyRoot(churnTarget, TAB_ID)
    const attachingTarget = document.createElement('div')
    buildNeverReadyRoot(attachingTarget, OTHER_TAB_ID)
    for (const target of [churnTarget, attachingTarget]) {
      document.body.append(target)
    }

    type SelectedPane = { target: HTMLElement; paneKey: string }
    let selectPane: (pane: SelectedPane) => void = () => {}
    let status = 'loading'

    function ActivityTerminalSlot(): null {
      const [pane, setPane] = useState<SelectedPane>({ target: churnTarget, paneKey: PANE_A })
      selectPane = setPane
      status = useActivityTerminalPortalStatus(pane.target, pane.paneKey)
      return null
    }

    root = createRoot(document.createElement('div'))
    act(() => {
      root.render(<ActivityTerminalSlot />)
    })

    // Two clicks a second between a live thread ('loading') and a retained one ('unavailable').
    for (let click = 1; click <= 10; click += 1) {
      vi.setSystemTime(click * 500)
      await act(async () => {
        selectPane({ target: churnTarget, paneKey: click % 2 === 0 ? PANE_A : PANE_B })
      })
      await drainReadinessFrame()
    }

    vi.setSystemTime(5_500)
    await act(async () => {
      selectPane({ target: attachingTarget, paneKey: `${OTHER_TAB_ID}:${LEAF_A}` })
    })
    await drainReadinessFrame()
    expect(status).toBe('loading')
  })
})
