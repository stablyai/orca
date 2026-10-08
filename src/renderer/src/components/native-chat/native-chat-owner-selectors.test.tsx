// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID, getDefaultSettings } from '../../../../shared/constants'
import type { Tab } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  createNativeChatFileLinkContextSelector,
  createNativeChatTabOwnerSelector,
  findNativeChatTabOwnerWorktreeId,
  resolveNativeChatFileLinkContext
} from './native-chat-file-link'
import { useNativeChatTabOwnerWorktreeId } from './use-native-chat-tab-owner'
import { useNativeChatFileLinkContext } from './use-native-chat-file-link-context'
import { useAppStore } from '@/store'

type ContextState = Parameters<typeof resolveNativeChatFileLinkContext>[0]

vi.mock('@/store', async () => {
  const { create } = await import('zustand')
  const { getDefaultSettings } = await import('../../../../shared/constants')
  return {
    useAppStore: create<ContextState>(() => ({
      settings: getDefaultSettings('/home/test'),
      repos: [],
      projectGroups: [],
      folderWorkspaces: [],
      worktreesByRepo: {},
      tabsByWorktree: {},
      unifiedTabsByWorktree: {},
      getKnownWorktreeById: () => undefined
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
    getKnownWorktreeById: () => undefined,
    ...overrides
  }
}

describe('native chat ownership selectors', () => {
  it.each(['chat', 'missing'])('does no ownership scans on unrelated hook updates for %s', (id) => {
    let reads = 0
    const counted = <T extends { id: string }>(tab: T): T => {
      const tabId = tab.id
      Object.defineProperty(tab, 'id', { enumerable: true, get: () => (reads++, tabId) })
      return tab
    }
    const state = contextState({
      tabsByWorktree: Object.fromEntries(
        Array.from({ length: 100 }, (_, index) => [
          `terminal-owner-${index}`,
          [counted(terminal(`terminal-${index}`))]
        ])
      ),
      unifiedTabsByWorktree: { 'chat-owner': [counted(structured('chat'))] },
      getKnownWorktreeById: (owner) => worktree(owner)
    })
    useAppStore.setState(state)
    const { result } = renderHook(() => ({
      owner: useNativeChatTabOwnerWorktreeId(id),
      context: useNativeChatFileLinkContext(id)
    }))
    expect(result.current.owner).toBe(id === 'chat' ? 'chat-owner' : null)
    expect(reads).toBeGreaterThan(0)
    reads = 0
    act(() => {
      for (let index = 0; index < 100; index++) {
        useAppStore.setState({ lastTerminalInputAtByPaneKey: { pane: index } })
      }
    })
    expect(reads).toBe(0)
    expect(result.current.context?.worktreePath ?? null).toBe(id === 'chat' ? '/repo' : null)
  })

  it('refreshes both hooks when the queried tab changes, moves, closes, or returns', () => {
    const state = contextState({
      unifiedTabsByWorktree: { first: [structured('one')], second: [structured('two')] },
      getKnownWorktreeById: (owner) => worktree(owner, `/${owner}`)
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

  it('keeps first-owner collisions, terminal precedence, and the structured content gate', () => {
    const select = createNativeChatTabOwnerSelector('same')
    const states = [
      contextState({
        tabsByWorktree: { first: [terminal('same')], second: [terminal('same')] },
        unifiedTabsByWorktree: { structured: [structured('same')] }
      }),
      contextState({
        unifiedTabsByWorktree: {
          editor: [structured('same', 'editor')],
          first: [structured('same')],
          second: [structured('same')]
        }
      }),
      contextState({ unifiedTabsByWorktree: { editor: [structured('same', 'editor')] } }),
      contextState()
    ]
    expect(states.map((state) => select(state))).toEqual(['first', 'first', null, null])
    for (const state of states) {
      expect(select(state)).toBe(findNativeChatTabOwnerWorktreeId(state, 'same'))
    }
  })

  it('updates directory and runtime projections without replacing the ownership maps', () => {
    let path = '/before'
    const initial = contextState({
      unifiedTabsByWorktree: { 'chat-owner': [structured('chat')] },
      getKnownWorktreeById: (owner) => worktree(owner, path),
      worktreesByRepo: { repo: [worktree('chat-owner')] }
    })
    const select = createNativeChatFileLinkContextSelector('chat')
    expect(select(initial)?.worktreePath).toBe('/before')
    path = '/after'
    const current = {
      ...initial,
      settings: { ...getDefaultSettings('/home/test'), activeRuntimeEnvironmentId: 'focused' },
      worktreesByRepo: {
        repo: [{ ...worktree('chat-owner'), runtimeOwnerEnvironmentId: 'owning-runtime' }]
      }
    }
    expect(select(current)).toEqual(resolveNativeChatFileLinkContext(current, 'chat'))
    expect(select(current)).toEqual({
      worktreeId: 'chat-owner',
      worktreePath: '/after',
      runtimeEnvironmentId: 'owning-runtime'
    })
  })

  it('waits for a floating chat pin and follows pin changes without an ownership change', () => {
    const initial = contextState({
      floatingWorkspacePath: '/setting',
      unifiedTabsByWorktree: { [FLOATING_TERMINAL_WORKTREE_ID]: [structured('chat')] }
    })
    const select = createNativeChatFileLinkContextSelector('chat')
    expect(select(initial)).toBeNull()
    for (const launchDirectory of ['/pinned', '/updated']) {
      const current = {
        ...initial,
        structuredSessionLaunchDirectoryByTabId: {
          chat: { sessionId: 'session-chat', launchDirectory }
        }
      }
      expect(select(current)?.worktreePath).toBe(launchDirectory)
      expect(select(current)).toEqual(resolveNativeChatFileLinkContext(current, 'chat'))
    }
  })
})
