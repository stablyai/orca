import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'

const { fakeStore } = vi.hoisted(() => {
  const layouts: Record<string, TerminalLayoutSnapshot> = {}
  const state = {
    tabsByWorktree: {},
    terminalLayoutsByTabId: layouts,
    setTabLayout: (tabId: string, layout: TerminalLayoutSnapshot) => {
      state.terminalLayoutsByTabId = { ...state.terminalLayoutsByTabId, [tabId]: layout }
    }
  }
  return { fakeStore: state }
})
vi.mock('../../store', () => ({ useAppStore: { getState: () => fakeStore } }))

import { applyRuntimePaneTitle } from './terminal-pane-title-ipc-bridge'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const SIBLING_ID = '22222222-2222-4222-8222-222222222222'
const LAYOUT: TerminalLayoutSnapshot = {
  root: {
    type: 'split',
    direction: 'horizontal',
    first: { type: 'leaf', leafId: LEAF_ID },
    second: { type: 'leaf', leafId: SIBLING_ID }
  },
  activeLeafId: SIBLING_ID,
  expandedLeafId: null,
  titlesByLeafId: { [SIBLING_ID]: 'DEVELOPER' },
  ptyIdsByLeafId: { [LEAF_ID]: 'pty-1', [SIBLING_ID]: 'pty-2' }
}

const dispatchEvent = vi.fn()
beforeEach(() => {
  fakeStore.terminalLayoutsByTabId = { 'tab-1': LAYOUT }
  dispatchEvent.mockReset()
  vi.stubGlobal('window', { dispatchEvent })
})
afterEach(() => vi.unstubAllGlobals())

const layout = (): TerminalLayoutSnapshot | undefined => fakeStore.terminalLayoutsByTabId['tab-1']

describe('a pane title from main', () => {
  it('saves set and clear in the layout for parked panes, leaving siblings alone', () => {
    applyRuntimePaneTitle({ tabId: 'tab-1', leafId: LEAF_ID, title: ' REVIEWER ' })
    expect(layout()).toEqual({
      ...LAYOUT,
      titlesByLeafId: { [SIBLING_ID]: 'DEVELOPER', [LEAF_ID]: 'REVIEWER' }
    })
    applyRuntimePaneTitle({ tabId: 'tab-1', leafId: LEAF_ID, title: null })
    expect(layout()).toEqual(LAYOUT)
  })

  it("names a never-mounted tab's one pane from a rootless layout", () => {
    const rootless: TerminalLayoutSnapshot = {
      root: null,
      activeLeafId: LEAF_ID,
      expandedLeafId: null,
      ptyIdsByLeafId: { [LEAF_ID]: 'pty-1' }
    }
    fakeStore.terminalLayoutsByTabId = { 'tab-1': rootless }
    applyRuntimePaneTitle({ tabId: 'tab-1', leafId: LEAF_ID, title: 'REVIEWER' })
    expect(layout()).toEqual({ ...rootless, titlesByLeafId: { [LEAF_ID]: 'REVIEWER' } })
  })

  it('ignores unknown tabs, leaves outside the layout, and non-leaf ids', () => {
    applyRuntimePaneTitle({ tabId: 'other-tab', leafId: LEAF_ID, title: 'WRONG' })
    applyRuntimePaneTitle({
      tabId: 'tab-1',
      leafId: '33333333-3333-4333-8333-333333333333',
      title: 'WRONG'
    })
    applyRuntimePaneTitle({ tabId: 'tab-1', leafId: 'pane:7', title: 'WRONG' })
    expect(layout()).toEqual(LAYOUT)
    expect(dispatchEvent).not.toHaveBeenCalled()
  })
})
