// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../../../shared/constants'
import type { Tab } from '../../../../../../shared/tab-types'
import type { TerminalTab } from '../../../../../../shared/workspace-layout/terminal-tab-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  createNativeChatFileLinkContextSelector,
  resolveNativeChatFileLinkContext
} from '../../links/actions/native-chat-file-link-context'
import { useNativeChatTabOwnerWorktreeId } from './use-native-chat-tab-owner'
import { useNativeChatFileLinkContext } from '../../links/actions/use-native-chat-file-link-context'
import { useAppStore } from '@/store'

type ContextState = Parameters<typeof resolveNativeChatFileLinkContext>[0]

vi.mock('@/store', async () => {
  const { create } = await import('zustand')
  const { getDefaultSettings } = await import('../../../../../../shared/constants')
  return {
    useAppStore: create<ContextState>(() => ({
      settings: getDefaultSettings('/home/test'),
      repos: [],
      projectGroups: [],
      folderWorkspaces: [],
      worktreesByRepo: {},
      tabsByWorktree: {},
      unifiedTabsByWorktree: {},
      detectedWorktreesByRepo: {},
      floatingWorkspacePath: null
    }))
  }
})

afterEach(cleanup)

function terminal(id: string): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId: 'terminal-owner',
    title: 'Terminal',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function structured(id: string, contentType: Tab['contentType'] = 'agent-session'): Tab {
  return {
    id,
    entityId: `session-${id}`,
    worktreeId: 'chat-owner',
    groupId: 'group',
    contentType,
    agentSessionAgent: 'codex',
    label: 'Chat',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function worktree(id: string, path = '/repo'): Worktree {
  return {
    id,
    repoId: 'repo',
    path,
    displayName: id,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    head: '',
    branch: 'main',
    isBare: false,
    isMainWorktree: false
  }
}

function contextState(overrides: Partial<ContextState> = {}): ContextState {
  return {
    settings: getDefaultSettings('/home/test'),
    repos: [],
    projectGroups: [],
    folderWorkspaces: [],
    worktreesByRepo: {},
    tabsByWorktree: {},
    unifiedTabsByWorktree: {},
    detectedWorktreesByRepo: {},
    floatingWorkspacePath: null,
    ...overrides
  }
}

describe('native chat ownership selectors', () => {
  it('refreshes both hooks when the queried tab changes, moves, closes, or returns', () => {
    const state = contextState({
      unifiedTabsByWorktree: { first: [structured('one')], second: [structured('two')] },
      worktreesByRepo: {
        repo: ['first', 'second', 'returned'].map((owner) => worktree(owner, `/${owner}`))
      }
    })
    useAppStore.setState(state)
    const { result, rerender, unmount } = renderHook(
      ({ id }) => ({
        owner: useNativeChatTabOwnerWorktreeId(id),
        context: useNativeChatFileLinkContext(id)
      }),
      { initialProps: { id: 'one' } }
    )
    expect(result.current.context?.worktreePath).toBe('/first')
    rerender({ id: 'two' })
    expect(result.current.context?.worktreePath).toBe('/second')
    act(() => useAppStore.setState({ unifiedTabsByWorktree: { first: [structured('two')] } }))
    expect(result.current.owner).toBe('first')
    act(() => useAppStore.setState({ unifiedTabsByWorktree: {} }))
    expect(result.current).toEqual({ owner: null, context: null })
    act(() => useAppStore.setState({ tabsByWorktree: { returned: [terminal('two')] } }))
    expect(result.current.context?.worktreePath).toBe('/returned')
    unmount()
    const reopened = renderHook(() => useNativeChatTabOwnerWorktreeId('two'))
    expect(reopened.result.current).toBe('returned')
  })

  it('updates directory and runtime projections without replacing the ownership maps', () => {
    const initial = contextState({
      unifiedTabsByWorktree: { 'chat-owner': [structured('chat')] },
      worktreesByRepo: { repo: [worktree('chat-owner', '/before')] }
    })
    const select = createNativeChatFileLinkContextSelector('chat')
    expect(select(initial)?.worktreePath).toBe('/before')
    const current = {
      ...initial,
      settings: { ...getDefaultSettings('/home/test'), activeRuntimeEnvironmentId: 'focused' },
      worktreesByRepo: {
        repo: [{ ...worktree('chat-owner', '/after'), runtimeOwnerEnvironmentId: 'owning-runtime' }]
      }
    }
    expect(select(current)).toEqual(resolveNativeChatFileLinkContext(current, 'chat'))
    expect(select(current)).toEqual({
      worktreeId: 'chat-owner',
      worktreePath: '/after',
      runtimeEnvironmentId: 'owning-runtime',
      sourceTabId: 'chat'
    })
    useAppStore.setState(current)
    expect(select(initial)?.worktreePath).toBe('/before')
  })
})
