import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import type { Tab } from '../../../../shared/tab-types'
import {
  makeRepo,
  makeWorkingEntryWithoutHistory,
  makeWorktree,
  PANE_KEY
} from './ActivityPrototypePage-test-fixtures'
import { buildActivityEvents } from './activity-event-builder'

function build(args: {
  entry: AgentStatusEntry
  unifiedTabs?: Tab[]
}): ReturnType<typeof buildActivityEvents> {
  const repo = makeRepo()
  const worktree = makeWorktree()
  return buildActivityEvents({
    agentStatusByPaneKey: { [PANE_KEY]: args.entry },
    retainedAgentsByPaneKey: {},
    tabsByWorktree: { [worktree.id]: [] },
    unifiedTabsByWorktree: { [worktree.id]: args.unifiedTabs ?? [] },
    worktreeMap: new Map([[worktree.id, worktree]]),
    repoMap: new Map([[repo.id, repo]]),
    acknowledgedAgentsByPaneKey: {},
    now: 3_000
  })
}

describe('activity event agent contexts', () => {
  it('builds a live thread context from a unified structured-agent tab', () => {
    const structuredTab = {
      id: 'tab-1',
      entityId: 'session-1',
      groupId: 'group-1',
      worktreeId: 'wt-1',
      executionHostId: 'local',
      contentType: 'agent-session',
      label: 'Codex chat',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: 1,
      agentSessionAgent: 'codex'
    } satisfies Tab

    const result = build({
      entry: makeWorkingEntryWithoutHistory(),
      unifiedTabs: [structuredTab]
    })

    expect(result.liveAgentByPaneKey[PANE_KEY]).toMatchObject({
      state: 'working',
      worktree: { id: 'wt-1' },
      tab: { id: 'tab-1', ptyId: null, title: 'Codex chat' }
    })
  })

  it('uses direct worktree attribution before an agent tab reaches the renderer', () => {
    const result = build({
      entry: {
        ...makeWorkingEntryWithoutHistory(),
        worktreeId: 'wt-1'
      }
    })

    expect(result.liveAgentByPaneKey[PANE_KEY]).toMatchObject({
      state: 'working',
      worktree: { id: 'wt-1' },
      tab: { id: 'tab-1', worktreeId: 'wt-1', ptyId: null }
    })
  })

  it('preserves a unified structured session remote-runtime owner', () => {
    const localRepo = makeRepo()
    const runtimeRepo = {
      ...makeRepo(),
      executionHostId: 'runtime:env-1' as const,
      displayName: 'Runtime repo'
    }
    const localWorktree = makeWorktree()
    const runtimeWorktree = {
      ...makeWorktree(),
      hostId: 'runtime:env-1' as const,
      runtimeOwnerEnvironmentId: 'env-1',
      displayName: 'Runtime worktree'
    }
    const structuredTab = {
      id: 'tab-1',
      entityId: 'session-1',
      groupId: 'group-1',
      worktreeId: 'wt-1',
      executionHostId: 'runtime:env-1',
      contentType: 'agent-session',
      label: 'Remote Codex chat',
      customLabel: null,
      color: null,
      sortOrder: 0,
      createdAt: 1,
      agentSessionAgent: 'codex'
    } satisfies Tab
    const resolveWorktree = vi.fn((_worktreeId, executionHostId) =>
      executionHostId === 'runtime:env-1' ? runtimeWorktree : localWorktree
    )

    const result = buildActivityEvents({
      agentStatusByPaneKey: {
        [PANE_KEY]: { ...makeWorkingEntryWithoutHistory(), connectionId: null }
      },
      retainedAgentsByPaneKey: {},
      tabsByWorktree: { [localWorktree.id]: [] },
      unifiedTabsByWorktree: { [localWorktree.id]: [structuredTab] },
      worktreeMap: new Map([[localWorktree.id, localWorktree]]),
      repoMap: new Map([[localRepo.id, localRepo]]),
      repos: [localRepo, runtimeRepo],
      resolveWorktree,
      acknowledgedAgentsByPaneKey: {},
      now: 3_000
    })

    expect(resolveWorktree).toHaveBeenCalledWith('wt-1', 'runtime:env-1')
    expect(result.liveAgentByPaneKey[PANE_KEY]?.worktree).toBe(runtimeWorktree)
    expect(result.liveAgentByPaneKey[PANE_KEY]?.repo).toBe(runtimeRepo)
  })

  it('preserves an early worktree-attributed SSH owner before its tab arrives', () => {
    const localRepo = makeRepo()
    const remoteRepo = {
      ...makeRepo(),
      connectionId: 'builder',
      displayName: 'SSH repo'
    }
    const localWorktree = makeWorktree()
    const remoteWorktree = {
      ...makeWorktree(),
      hostId: 'ssh:builder' as const,
      displayName: 'SSH worktree'
    }
    const resolveWorktree = vi.fn((_worktreeId, executionHostId) =>
      executionHostId === 'ssh:builder' ? remoteWorktree : localWorktree
    )

    const result = buildActivityEvents({
      agentStatusByPaneKey: {
        [PANE_KEY]: {
          ...makeWorkingEntryWithoutHistory(),
          worktreeId: 'wt-1',
          connectionId: 'builder'
        }
      },
      retainedAgentsByPaneKey: {},
      tabsByWorktree: { [localWorktree.id]: [] },
      worktreeMap: new Map([[localWorktree.id, localWorktree]]),
      repoMap: new Map([[localRepo.id, localRepo]]),
      repos: [localRepo, remoteRepo],
      resolveWorktree,
      acknowledgedAgentsByPaneKey: {},
      now: 3_000
    })

    expect(resolveWorktree).toHaveBeenCalledWith('wt-1', 'ssh:builder')
    expect(result.liveAgentByPaneKey[PANE_KEY]?.worktree).toBe(remoteWorktree)
    expect(result.liveAgentByPaneKey[PANE_KEY]?.repo).toBe(remoteRepo)
  })
})
