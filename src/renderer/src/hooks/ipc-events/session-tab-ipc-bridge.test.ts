// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { useAppStore } from '../../store'
import { LOCAL_STRUCTURED_SESSION_OWNER } from '../../runtime/local-structured-session-owner'
import {
  clearHostSessionTabIdMappings,
  setHostSessionTabIdMapping
} from '../../runtime/web-session-tabs-sync/tracking-mappings'
import { applySessionTabProps } from './session-tab-ipc-bridge'

const scheduleRuntimeGraphSync = vi.hoisted(() => vi.fn())

vi.mock('@/runtime/sync-runtime-graph', () => ({ scheduleRuntimeGraphSync }))

const WORKTREE_ID = 'repo::worktree'
const LOCAL_TAB_ID = 'local-terminal'
const HOST_TAB_ID = 'host-terminal'

const unifiedTab: Tab = {
  id: LOCAL_TAB_ID,
  entityId: LOCAL_TAB_ID,
  groupId: 'group-1',
  worktreeId: WORKTREE_ID,
  contentType: 'terminal',
  label: 'Terminal',
  customLabel: null,
  color: null,
  sortOrder: 0,
  createdAt: 1
}

const terminalRow: TerminalTab = {
  id: LOCAL_TAB_ID,
  ptyId: null,
  worktreeId: WORKTREE_ID,
  title: 'Terminal',
  customTitle: null,
  color: null,
  sortOrder: 0,
  createdAt: 1
}

describe('renderer-authoritative session tab props', () => {
  const initialState = useAppStore.getState()

  beforeEach(() => {
    setHostSessionTabIdMapping(
      {
        environmentId: LOCAL_STRUCTURED_SESSION_OWNER,
        worktreeId: WORKTREE_ID,
        tabId: LOCAL_TAB_ID
      },
      HOST_TAB_ID
    )
    useAppStore.setState({
      ...initialState,
      unifiedTabsByWorktree: { [WORKTREE_ID]: [unifiedTab] },
      tabsByWorktree: { [WORKTREE_ID]: [terminalRow] },
      setTabViewMode: vi.fn()
    })
  })

  afterEach(() => {
    clearHostSessionTabIdMappings(LOCAL_STRUCTURED_SESSION_OWNER, WORKTREE_ID)
    useAppStore.setState(initialState, true)
  })

  it('resolves the host tab to the local tab and patches unified plus legacy rows', () => {
    applySessionTabProps({ worktreeId: WORKTREE_ID, tabId: HOST_TAB_ID, viewMode: 'chat' })

    const state = useAppStore.getState()
    expect(state.unifiedTabsByWorktree[WORKTREE_ID]?.[0].viewMode).toBe('chat')
    expect(state.tabsByWorktree[WORKTREE_ID]?.[0].viewMode).toBe('chat')
    expect(state.setTabViewMode).not.toHaveBeenCalled()
    expect(scheduleRuntimeGraphSync).toHaveBeenCalledTimes(1)
  })

  it('refuses to acknowledge a missing or non-terminal target', () => {
    useAppStore.setState({ unifiedTabsByWorktree: { [WORKTREE_ID]: [] } })

    expect(() =>
      applySessionTabProps({ worktreeId: WORKTREE_ID, tabId: HOST_TAB_ID, viewMode: 'chat' })
    ).toThrow('session_tab_not_found')
    expect(useAppStore.getState().tabsByWorktree[WORKTREE_ID]?.[0].viewMode).toBeUndefined()
  })

  it('refuses a target resolved outside the requested worktree', () => {
    const otherWorktree = 'repo::other-worktree'
    useAppStore.setState({
      unifiedTabsByWorktree: { [otherWorktree]: [unifiedTab] },
      tabsByWorktree: { [otherWorktree]: [terminalRow] }
    })

    expect(() =>
      applySessionTabProps({ worktreeId: WORKTREE_ID, tabId: HOST_TAB_ID, viewMode: 'chat' })
    ).toThrow('session_tab_not_found')
    expect(useAppStore.getState().tabsByWorktree[otherWorktree]?.[0].viewMode).toBeUndefined()
  })
})
