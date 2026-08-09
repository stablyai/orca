/** @vitest-environment happy-dom */
import { act, useLayoutEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { useActivityTerminalPortalStatus } from './ActivityPrototypePage'
import {
  findActivityTerminalPortal,
  type ActivityTerminalPortalTarget
} from './activity-terminal-portal'
import {
  reconcileActivityPortalThreads,
  resolveActivityPortalSwap,
  type ActivityPortalThreadRef
} from './activity-portal-thread-reconciliation'

const WORKTREE_ID = 'wt-1'
const TAB_ID = 'tab-react185'
const OTHER_TAB_ID = 'tab-react185-other'
const LEAF_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const LEAF_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
const LEAF_C = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1'

const thread = (tabId: string, leafId: string): ActivityPortalThreadRef => ({
  paneKey: `${tabId}:${leafId}`,
  worktree: { id: WORKTREE_ID },
  tab: { id: tabId }
})

// Same-tab panes share one TerminalPane and swap via isolatedPaneKey.
const PANE_A = thread(TAB_ID, LEAF_A)
const PANE_B = thread(TAB_ID, LEAF_B)
// Cross-tab panes use separate TerminalPanes, so staging applies.
const PANE_C = thread(OTHER_TAB_ID, LEAF_C)

let root: Root

afterEach(() => {
  act(() => {
    root?.unmount()
  })
  document.body.replaceChildren()
})

// Models the tab-root DOM and sibling hiding emitted by a portaled TerminalPane.
function renderPortaledTerminalPane(target: HTMLElement, tabId: string, leafIds: string[]): void {
  const isolatedLeafId = leafIds[0]
  const tabRoot = document.createElement('div')
  tabRoot.dataset.terminalTabId = tabId
  for (const leafId of leafIds) {
    const pane = document.createElement('div')
    pane.dataset.leafId = leafId
    pane.setAttribute('data-pty-id', `pty-${leafId}`)
    pane.appendChild(Object.assign(document.createElement('div'), { className: 'xterm-screen' }))
    if (leafId !== isolatedLeafId) {
      pane.style.display = 'none'
    }
    Object.defineProperty(pane, 'getClientRects', {
      value: () => (leafId === isolatedLeafId ? [{}] : []),
      configurable: true
    })
    tabRoot.appendChild(pane)
  }
  target.replaceChildren(tabRoot)
}

// Exercises reconciliation, routing, readiness, and swapping on React's sync lane.
async function runActivityPortalPage(args: {
  selectedThread: ActivityPortalThreadRef
  initialDisplayed: ActivityPortalThreadRef
  leafIdsByTabId: Record<string, string[]>
}): Promise<{ displayedPaneKey: string | null; renders: number }> {
  const { selectedThread, initialDisplayed, leafIdsByTabId } = args
  const slotEls = {
    primary: document.createElement('div'),
    secondary: document.createElement('div')
  }
  document.body.append(slotEls.primary, slotEls.secondary)
  const threadsByPaneKey = new Map(
    [selectedThread, initialDisplayed].map((entry) => [entry.paneKey, entry])
  )
  let renders = 0
  let displayedPaneKey: string | null = initialDisplayed.paneKey

  function ActivityPortalPage(): null {
    renders += 1
    const [displayed, setDisplayed] = useState<string | null>(initialDisplayed.paneKey)
    const [activeSlotId, setActiveSlotId] = useState<'primary' | 'secondary'>('primary')
    displayedPaneKey = displayed
    const inactiveSlotId = activeSlotId === 'primary' ? 'secondary' : 'primary'

    const { visibleThread, stagedThread } = reconcileActivityPortalThreads({
      selectedThread,
      displayedThread: displayed ? (threadsByPaneKey.get(displayed) ?? null) : null,
      selectedHasLiveTab: true,
      displayedHasLiveTab: true
    })

    const descriptors: ActivityTerminalPortalTarget[] = []
    if (visibleThread) {
      descriptors.push({
        slotId: activeSlotId,
        requestToken: `${activeSlotId}:${visibleThread.paneKey}`,
        target: slotEls[activeSlotId],
        worktreeId: WORKTREE_ID,
        tabId: visibleThread.tab.id,
        paneKey: visibleThread.paneKey,
        active: true
      })
    }
    if (stagedThread) {
      descriptors.push({
        slotId: inactiveSlotId,
        requestToken: `${inactiveSlotId}:${stagedThread.paneKey}`,
        target: slotEls[inactiveSlotId],
        worktreeId: WORKTREE_ID,
        tabId: stagedThread.tab.id,
        paneKey: stagedThread.paneKey,
        active: false
      })
    }

    // Match Terminal's one-pane-per-(worktree, tab) routing.
    useLayoutEffect(() => {
      slotEls.primary.replaceChildren()
      slotEls.secondary.replaceChildren()
      for (const tabId of Object.keys(leafIdsByTabId)) {
        const routed = findActivityTerminalPortal(descriptors, { worktreeId: WORKTREE_ID, tabId })
        if (!routed) {
          continue
        }
        const isolatedLeafId = routed.paneKey.slice(routed.paneKey.indexOf(':') + 1)
        const leafIds = leafIdsByTabId[tabId]
        renderPortaledTerminalPane(routed.target, tabId, [
          isolatedLeafId,
          ...leafIds.filter((leafId) => leafId !== isolatedLeafId)
        ])
      }
    })

    const visibleStatus = useActivityTerminalPortalStatus(
      slotEls[activeSlotId],
      visibleThread?.paneKey ?? null
    )
    const stagedStatus = useActivityTerminalPortalStatus(
      slotEls[inactiveSlotId],
      stagedThread?.paneKey ?? null
    )

    useLayoutEffect(() => {
      const swap = resolveActivityPortalSwap({
        displayedPaneKey: displayed,
        selectedThread,
        selectedHasLiveTab: true,
        visibleThread,
        stagedThread,
        visiblePortalReady: visibleStatus === 'ready',
        stagedPortalReady: stagedStatus === 'ready',
        stagedPortalUnavailable: stagedStatus === 'unavailable'
      })
      if (swap?.kind === 'clear') {
        setDisplayed(null)
        return
      }
      if (swap?.kind === 'swap-staged') {
        setActiveSlotId(inactiveSlotId)
        setDisplayed(swap.paneKey)
        return
      }
      if (swap?.kind === 'settle-visible') {
        setDisplayed(swap.paneKey)
      }
      // Mirror ActivityPrototypePage's swap dependencies.
    }, [displayed, inactiveSlotId, stagedStatus, stagedThread, visibleStatus, visibleThread])
    return null
  }

  root = createRoot(document.createElement('div'))
  await act(async () => {
    root.render(<ActivityPortalPage />)
    await new Promise((resolve) => setTimeout(resolve, 40))
  })
  return { displayedPaneKey, renders }
}

describe('Activity portal pane switching', () => {
  it('converges on a newly selected pane of the tab already on screen', async () => {
    // Same-tab staging would wait forever for a second TerminalPane that never mounts.
    const run = (): Promise<{ displayedPaneKey: string | null; renders: number }> =>
      runActivityPortalPage({
        selectedThread: PANE_B,
        initialDisplayed: PANE_A,
        leafIdsByTabId: { [TAB_ID]: [LEAF_A, LEAF_B] }
      })

    const result = await run()
    expect(result.displayedPaneKey).toBe(PANE_B.paneKey)
    expect(result.renders).toBeLessThan(50)
  })

  it('stages and swaps when the selected pane belongs to a different tab', async () => {
    const result = await runActivityPortalPage({
      selectedThread: PANE_C,
      initialDisplayed: PANE_A,
      leafIdsByTabId: { [TAB_ID]: [LEAF_A, LEAF_B], [OTHER_TAB_ID]: [LEAF_C] }
    })
    expect(result.displayedPaneKey).toBe(PANE_C.paneKey)
    expect(result.renders).toBeLessThan(50)
  })
})
