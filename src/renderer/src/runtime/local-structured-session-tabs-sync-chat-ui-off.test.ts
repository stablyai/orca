// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import { STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { useAppStore } from '../store'
import {
  resetLocalStructuredSessionVersionForTests,
  useLocalStructuredSessionTabsSync
} from './local-structured-session-tabs-sync'

const WORKTREE_ID = 'repo-1::worktree-1'
const CHAT_TAB_ID = 'agent-session:codex-1'

function inventoryWithOpenChat(): RuntimeMobileSessionTabsResult {
  return {
    worktree: WORKTREE_ID,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: 'group-1',
    activeTabId: CHAT_TAB_ID,
    activeTabType: 'agent-session',
    tabGroups: [{ id: 'group-1', activeTabId: CHAT_TAB_ID, tabOrder: [CHAT_TAB_ID] }],
    tabs: [
      {
        type: 'agent-session',
        id: CHAT_TAB_ID,
        title: 'Codex Chat',
        sessionId: 'codex-1',
        agent: 'codex',
        isActive: true
      }
    ]
  }
}

function openChatIds(): string[] {
  return (useAppStore.getState().unifiedTabsByWorktree[WORKTREE_ID] ?? [])
    .filter((tab) => tab.contentType === 'agent-session')
    .map((tab) => tab.entityId)
}

const priorApi = window.api
const unsubscribe = vi.fn()
const subscribe = vi.fn(async () => ({ unsubscribe }))
const call = vi.fn(async () => ({ ok: true, result: { snapshots: [inventoryWithOpenChat()] } }))
const hasLocalStructuredAgentSessions = vi.fn(async () => true)
const getStatus = vi.fn(async () => ({
  capabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
}))

function setChatUi(experimentalNativeChat: boolean): void {
  useAppStore.setState({ settings: { ...getDefaultSettings(''), experimentalNativeChat } })
}

beforeEach(() => {
  unsubscribe.mockClear()
  subscribe.mockClear()
  call.mockClear()
  hasLocalStructuredAgentSessions.mockReset().mockResolvedValue(true)
  getStatus.mockReset().mockResolvedValue({
    capabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
  })
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      app: { hasLocalStructuredAgentSessions },
      runtime: {
        getStatus,
        call,
        subscribe
      }
    }
  })
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    settings: { ...getDefaultSettings(''), experimentalNativeChat: false },
    unifiedTabsByWorktree: { [WORKTREE_ID]: [] },
    workspaceSessionReady: true,
    terminalStartupRestorationReady: true
  })
})

afterEach(() => {
  resetLocalStructuredSessionVersionForTests()
  Object.defineProperty(window, 'api', { configurable: true, value: priorApi })
})

describe('local structured session tab sync', () => {
  it('costs a user who never had a structured chat nothing but the existence check', async () => {
    hasLocalStructuredAgentSessions.mockResolvedValue(false)
    const { unmount } = renderHook(() => useLocalStructuredSessionTabsSync())
    await vi.waitFor(() => expect(hasLocalStructuredAgentSessions).toHaveBeenCalledOnce())
    await act(async () => {})

    expect(call).not.toHaveBeenCalled()
    expect(subscribe).not.toHaveBeenCalled()
    unmount()
  })

  it('mirrors chats the host holds with Chat UI off', async () => {
    const { unmount } = renderHook(() => useLocalStructuredSessionTabsSync())
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledOnce())

    expect(call).toHaveBeenCalledWith({ method: 'session.tabs.listAll', params: {} })
    expect(openChatIds()).toEqual(['codex-1'])
    unmount()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('starts when Chat UI comes on, without asking the host', async () => {
    hasLocalStructuredAgentSessions.mockResolvedValue(false)
    const { unmount } = renderHook(() => useLocalStructuredSessionTabsSync())
    await vi.waitFor(() => expect(hasLocalStructuredAgentSessions).toHaveBeenCalledOnce())
    expect(subscribe).not.toHaveBeenCalled()

    await act(async () => setChatUi(true))

    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledOnce())
    expect(hasLocalStructuredAgentSessions).toHaveBeenCalledOnce()
    unmount()
  })

  it('subscribes on its own backoff after the capability probe fails', async () => {
    // Startup probe, the restore's probe, and the first subscribe attempt all fail.
    for (let failure = 0; failure < 3; failure += 1) {
      getStatus.mockRejectedValueOnce(new Error('runtime not ready'))
    }
    const { unmount } = renderHook(() => useLocalStructuredSessionTabsSync())

    // A failed probe is not a "no": no Chat UI change is needed for the mirror to go live.
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledOnce(), { timeout: 2000 })
    expect(getStatus).toHaveBeenCalledTimes(4)
    unmount()
  })

  it('lets a later Chat UI change retry a host that answered without the surface', async () => {
    getStatus.mockResolvedValueOnce({ capabilities: [] })
    const { unmount } = renderHook(() => useLocalStructuredSessionTabsSync())
    await vi.waitFor(() => expect(getStatus).toHaveBeenCalled())
    await act(async () => {})
    expect(subscribe).not.toHaveBeenCalled()

    await act(async () => setChatUi(true))

    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledOnce())
    unmount()
  })

  it('keeps running and keeps open chats when Chat UI goes off', async () => {
    setChatUi(true)
    const { unmount } = renderHook(() => useLocalStructuredSessionTabsSync())
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledOnce())
    expect(openChatIds()).toEqual(['codex-1'])

    await act(async () => setChatUi(false))
    await act(async () => setChatUi(true))
    await act(async () => setChatUi(false))

    // The setting decides how new launches open; it neither retracts nor re-subscribes the mirror.
    expect(openChatIds()).toEqual(['codex-1'])
    expect(unsubscribe).not.toHaveBeenCalled()
    expect(subscribe).toHaveBeenCalledOnce()
    expect(hasLocalStructuredAgentSessions).not.toHaveBeenCalled()
    unmount()
  })
})
