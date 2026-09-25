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

beforeEach(() => {
  unsubscribe.mockClear()
  subscribe.mockClear()
  call.mockClear()
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      runtime: {
        getStatus: vi.fn(async () => ({
          capabilities: [STRUCTURED_AGENT_SESSION_RUNTIME_CAPABILITY]
        })),
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

describe('local structured session tab sync with Chat UI off', () => {
  it('mirrors the host chats and keeps them through a Chat UI toggle', async () => {
    const { unmount } = renderHook(() => useLocalStructuredSessionTabsSync())
    await vi.waitFor(() => expect(subscribe).toHaveBeenCalledOnce())

    expect(call).toHaveBeenCalledWith({ method: 'session.tabs.listAll', params: {} })
    expect(openChatIds()).toEqual(['codex-1'])

    await act(async () => {
      useAppStore.setState({
        settings: { ...getDefaultSettings(''), experimentalNativeChat: true }
      })
    })
    await act(async () => {
      useAppStore.setState({
        settings: { ...getDefaultSettings(''), experimentalNativeChat: false }
      })
    })

    // The setting decides how new launches open; it neither retracts nor re-subscribes the mirror.
    expect(openChatIds()).toEqual(['codex-1'])
    expect(unsubscribe).not.toHaveBeenCalled()
    expect(subscribe).toHaveBeenCalledOnce()
    unmount()
  })
})
