import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import { CLOSE_TERMINAL_PANE_EVENT } from '@/constants/terminal'

const TAB_ID = 'tab-1'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const SIBLING_LEAF_ID = '22222222-2222-4222-8222-222222222222'

const splitLayout: TerminalLayoutSnapshot = {
  root: {
    type: 'split',
    direction: 'vertical',
    first: { type: 'leaf', leafId: LEAF_ID },
    second: { type: 'leaf', leafId: SIBLING_LEAF_ID }
  },
  activeLeafId: LEAF_ID,
  expandedLeafId: null,
  ptyIdsByLeafId: { [LEAF_ID]: 'pty-closed', [SIBLING_LEAF_ID]: 'pty-sibling' }
}

const layouts: Record<string, TerminalLayoutSnapshot> = {}
const state = {
  tabsByWorktree: {},
  terminalLayoutsByTabId: layouts,
  runtimePaneTitlesByTabId: {},
  clearTabLaunchAgent: vi.fn(),
  updateTabTitle: vi.fn(),
  setTabLayout: vi.fn((tabId: string, layout: TerminalLayoutSnapshot) => {
    state.terminalLayoutsByTabId[tabId] = layout
  })
}

vi.mock('@/store', () => ({ useAppStore: { getState: () => state } }))

import { applyClosedTerminalLeafNotice } from './closed-terminal-leaf-notice'
import { applyTerminalPaneCloseRequest } from './terminal-pane-lifecycle-close'
import { parkedWatchersByTabId } from './terminal-parked-watcher-registry'

function leafIds(layout: TerminalLayoutSnapshot | undefined): string[] {
  return Object.keys(layout?.ptyIdsByLeafId ?? {})
}

beforeEach(() => {
  state.terminalLayoutsByTabId = { [TAB_ID]: splitLayout }
  state.setTabLayout.mockClear()
  vi.stubGlobal('window', new EventTarget())
})

afterEach(() => {
  parkedWatchersByTabId.clear()
  vi.unstubAllGlobals()
})

describe('a split pane main already closed', () => {
  it('reaches a mounted pane as a leaf-addressed close', () => {
    const details: unknown[] = []
    window.addEventListener(CLOSE_TERMINAL_PANE_EVENT, (event) =>
      details.push(event instanceof CustomEvent ? event.detail : null)
    )

    applyClosedTerminalLeafNotice(TAB_ID, LEAF_ID)

    expect(details).toEqual([{ tabId: TAB_ID, leafId: LEAF_ID }])
  })

  it('is ignored by a mounted pane whose exit already removed that leaf', () => {
    const manager = {
      closePane: vi.fn(),
      detachPaneForExternalMove: vi.fn(),
      retirePanePreservingPty: vi.fn(),
      getNumericIdForLeaf: () => null,
      getPanes: () => [{ id: 2 }]
    }
    const closeTab = vi.fn()

    const result = applyTerminalPaneCloseRequest({
      detail: { tabId: TAB_ID, leafId: LEAF_ID },
      manager,
      closeTab,
      closeTabPreservingPty: vi.fn()
    })

    // Why: a numeric pane id would have reached the last-pane branch and closed the whole tab.
    expect(result).toBe('ignored')
    expect(closeTab).not.toHaveBeenCalled()
    expect(manager.closePane).not.toHaveBeenCalled()
  })

  it('collapses a parked tab stored layout once, whichever of notice or exit lands first', () => {
    parkedWatchersByTabId.set(TAB_ID, {
      worktreeId: 'repo::/worktree',
      tabPtyId: 'pty-closed',
      disposersByPtyId: new Map([['pty-closed', vi.fn()]]),
      paneIdByPtyId: new Map()
    })

    applyClosedTerminalLeafNotice(TAB_ID, LEAF_ID)
    applyClosedTerminalLeafNotice(TAB_ID, LEAF_ID)

    expect(leafIds(state.terminalLayoutsByTabId[TAB_ID])).toEqual([SIBLING_LEAF_ID])
    expect(state.setTabLayout).toHaveBeenCalledTimes(1)
  })
})
