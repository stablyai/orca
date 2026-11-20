// @vitest-environment happy-dom

import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { Tab, TabGroup } from '../../../../../../shared/workspace-layout/tab-groups/tab-types'

type MockAppState = {
  unifiedTabsByWorktree: Record<string, readonly Tab[]>
  groupsByWorktree: Record<string, readonly TabGroup[]>
  activeGroupIdByWorktree: Record<string, string>
  focusGroup: (worktreeId: string, groupId: string) => void
}

const mocks = vi.hoisted(() => {
  const state: {
    store: null | { setState: (state: Partial<MockAppState>) => void }
    mounts: string[]
  } = { store: null, mounts: [] }
  return state
})

vi.mock('@/store', async () => {
  const { create } = await import('zustand')
  const useAppStore = create<MockAppState>(() => ({
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    activeGroupIdByWorktree: {},
    focusGroup: () => {}
  }))
  mocks.store = useAppStore
  return { useAppStore }
})

vi.mock('@/runtime/native-chat/session-ownership/structured-agent-session-owner', () => ({
  structuredAgentSessionOwnerForTab: () => 'local',
  structuredAgentSessionTargetForHost: () => ({ kind: 'local' })
}))

vi.mock('../../NativeChatView', async () => {
  const { useState } = await import('react')
  return {
    default: function MockNativeChatView({ tabId }: { tabId: string }) {
      // Hidden Activity re-runs effects on reveal; a state initializer runs once per real mount.
      useState(() => mocks.mounts.push(tabId))
      return <span data-chat-tab-id={tabId} />
    }
  }
})

import StructuredAgentSessionPaneOverlayLayer from './StructuredAgentSessionPaneOverlayLayer'

const WORKTREE_ID = 'wt-1'
const GROUP_ID = 'group-1'
const TAB_IDS = ['chat-1', 'chat-2', 'chat-3']

describe('StructuredAgentSessionPaneOverlayLayer', () => {
  afterEach(cleanup)

  it('mounts a chat when first shown, keeps it when hidden, and forgets it when closed', () => {
    mocks.mounts.length = 0
    mocks.store?.setState({
      unifiedTabsByWorktree: { [WORKTREE_ID]: TAB_IDS.map(chatTab) },
      groupsByWorktree: { [WORKTREE_ID]: [group('chat-1')] },
      activeGroupIdByWorktree: { [WORKTREE_ID]: GROUP_ID }
    })
    const view = render(
      <StructuredAgentSessionPaneOverlayLayer worktreeId={WORKTREE_ID} isWorktreeActive />
    )
    expect(mountedChats(view.container)).toEqual(['chat-1'])

    act(() => mocks.store?.setState({ groupsByWorktree: { [WORKTREE_ID]: [group('chat-2')] } }))
    expect(mountedChats(view.container)).toEqual(['chat-1', 'chat-2'])

    act(() => mocks.store?.setState({ groupsByWorktree: { [WORKTREE_ID]: [group('chat-1')] } }))
    expect(mountedChats(view.container)).toEqual(['chat-1', 'chat-2'])
    expect(mocks.mounts).toEqual(['chat-1', 'chat-2'])

    act(() =>
      mocks.store?.setState({
        unifiedTabsByWorktree: { [WORKTREE_ID]: ['chat-1', 'chat-3'].map(chatTab) }
      })
    )
    act(() =>
      mocks.store?.setState({ unifiedTabsByWorktree: { [WORKTREE_ID]: TAB_IDS.map(chatTab) } })
    )
    expect(mountedChats(view.container)).toEqual(['chat-1'])
  })
})

function mountedChats(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>('[data-chat-tab-id]')].map(
    (element) => element.dataset.chatTabId ?? ''
  )
}

function group(activeTabId: string): TabGroup {
  return { id: GROUP_ID, worktreeId: WORKTREE_ID, activeTabId, tabOrder: TAB_IDS }
}

function chatTab(id: string, sortOrder: number): Tab {
  return {
    id,
    entityId: `session-${id}`,
    groupId: GROUP_ID,
    worktreeId: WORKTREE_ID,
    contentType: 'agent-session',
    agentSessionAgent: 'codex',
    label: 'Codex Chat',
    customLabel: null,
    color: null,
    sortOrder,
    createdAt: sortOrder + 1
  }
}
