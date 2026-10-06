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
import { applySessionTabProps, registerSessionTabIpcBridge } from './session-tab-ipc-bridge'

const flushRuntimeGraphSync = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))

vi.mock('@/runtime/sync-runtime-graph', () => ({ flushRuntimeGraphSync }))

const WORKTREE_ID = 'repo::worktree'
const LOCAL_TAB_ID = 'local-terminal'
const HOST_TAB_ID = 'host-terminal'
type SessionTabPropsRequest = {
  requestId: string
  worktreeId: string
  tabId: string
  viewMode?: 'terminal' | 'chat'
}

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

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
} {
  let resolve: (value: T | PromiseLike<T>) => void = () => {}
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

describe('renderer-authoritative session tab props', () => {
  const initialState = useAppStore.getState()

  beforeEach(() => {
    flushRuntimeGraphSync.mockReset().mockResolvedValue(undefined)
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

  it('resolves the host tab to the local tab and patches unified plus legacy rows', async () => {
    await applySessionTabProps({ worktreeId: WORKTREE_ID, tabId: HOST_TAB_ID, viewMode: 'chat' })

    const state = useAppStore.getState()
    expect(state.unifiedTabsByWorktree[WORKTREE_ID]?.[0].viewMode).toBe('chat')
    expect(state.tabsByWorktree[WORKTREE_ID]?.[0].viewMode).toBe('chat')
    expect(state.setTabViewMode).not.toHaveBeenCalled()
    expect(flushRuntimeGraphSync).toHaveBeenCalledWith(WORKTREE_ID)
  })

  it('refuses to acknowledge a missing or non-terminal target', async () => {
    useAppStore.setState({ unifiedTabsByWorktree: { [WORKTREE_ID]: [] } })

    await expect(
      applySessionTabProps({ worktreeId: WORKTREE_ID, tabId: HOST_TAB_ID, viewMode: 'chat' })
    ).rejects.toThrow('session_tab_not_found')
    expect(useAppStore.getState().tabsByWorktree[WORKTREE_ID]?.[0].viewMode).toBeUndefined()
  })

  it('refuses a target resolved outside the requested worktree', async () => {
    const otherWorktree = 'repo::other-worktree'
    useAppStore.setState({
      unifiedTabsByWorktree: { [otherWorktree]: [unifiedTab] },
      tabsByWorktree: { [otherWorktree]: [terminalRow] }
    })

    await expect(
      applySessionTabProps({ worktreeId: WORKTREE_ID, tabId: HOST_TAB_ID, viewMode: 'chat' })
    ).rejects.toThrow('session_tab_not_found')
    expect(useAppStore.getState().tabsByWorktree[otherWorktree]?.[0].viewMode).toBeUndefined()
  })

  it('waits for graph publication before acknowledging the IPC request', async () => {
    let onSetSessionTabProps:
      | ((request: SessionTabPropsRequest) => void | Promise<void>)
      | undefined
    const respondSessionTabProps = vi.fn()
    vi.stubGlobal('window', {
      api: {
        ui: {
          onCloseSessionTab: () => () => {},
          onSessionTabCloseRequest: () => () => {},
          onMoveSessionTab: () => () => {},
          onSetSessionTabProps: (callback: (request: SessionTabPropsRequest) => void) => {
            onSetSessionTabProps = callback
            return () => {}
          },
          respondSessionTabProps
        }
      }
    })
    const publication = deferred<void>()
    flushRuntimeGraphSync.mockImplementationOnce(() => publication.promise)
    const unsubs: (() => void)[] = []
    registerSessionTabIpcBridge(unsubs)

    const request = onSetSessionTabProps?.({
      requestId: 'request-1',
      worktreeId: WORKTREE_ID,
      tabId: HOST_TAB_ID,
      viewMode: 'chat'
    })
    await Promise.resolve()
    expect(respondSessionTabProps).not.toHaveBeenCalled()
    publication.resolve()
    await request
    expect(respondSessionTabProps).toHaveBeenCalledWith({ requestId: 'request-1' })
    unsubs.forEach((unsubscribe) => unsubscribe())
  })
})
