import { setSessionTestState } from '@/lib/test-support/session-source-fixture'
// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { useAppStore } from '@/store'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import type { Tab } from '../../../../shared/tab-types'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import { makeRepo, makeWorktree } from '../worktree-jump-palette-test-fixtures'
import { useVisibleWorkspaceKanbanWorktreeIds } from './use-visible-workspace-kanban-worktree-ids'

const initialState = useAppStore.getInitialState()

describe('useVisibleWorkspaceKanbanWorktreeIds', () => {
  beforeEach(() => {
    setSessionTestState(useAppStore, initialState, true)
  })

  afterEach(() => {
    cleanup()
    setSessionTestState(useAppStore, initialState, true)
  })

  it('keeps a single-host filter host-qualified when workspace ids collide', () => {
    const local = makeWorktree('shared', 'Local workspace', { hostId: 'local' })
    const ssh = makeWorktree('shared', 'SSH workspace', { hostId: 'ssh:box' })
    const repo = makeRepo()
    setSessionTestState(useAppStore, {
      worktreesByRepo: { [repo.id]: [local, ssh] },
      showSleepingWorkspaces: true,
      visibleWorkspaceHostIds: ['local']
    })

    const { result } = renderHook(() =>
      useVisibleWorkspaceKanbanWorktreeIds({
        allWorktrees: [local, ssh],
        repoMap: new Map([[repo.id, repo]])
      })
    )

    expect(result.current).toEqual(new Set([getWorktreeHostIdentity(local)]))
  })

  it('keeps a structured-chat workspace visible when sleeping workspaces are hidden', () => {
    const worktree = makeWorktree('chat', 'Chat workspace')
    const repo = makeRepo()
    const structuredTab: Tab = {
      id: 'chat-tab',
      entityId: 'chat-session',
      groupId: 'chat-group',
      worktreeId: worktree.id,
      contentType: 'agent-session',
      agentSessionAgent: 'codex',
      label: 'Chat',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: 0
    }
    setSessionTestState(useAppStore, {
      worktreesByRepo: { [repo.id]: [worktree] },
      unifiedTabsByWorktree: { [worktree.id]: [structuredTab] },
      structuredChatSleptAtByPaneKey: {
        [structuredAgentSessionPaneKey(structuredTab.id, structuredTab.entityId)]: null
      },
      showSleepingWorkspaces: false
    })

    const { result } = renderHook(() =>
      useVisibleWorkspaceKanbanWorktreeIds({
        allWorktrees: [worktree],
        repoMap: new Map([[repo.id, repo]])
      })
    )

    expect(result.current).toEqual(new Set([getWorktreeHostIdentity(worktree)]))
  })
})
