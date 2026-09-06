import { describe, expect, it, vi } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  LEAF_ID,
  makeRepo,
  makeRetainedDoneEntry,
  makeTab,
  makeWorktree
} from './ActivityPrototypePage-test-fixtures'
import { buildActivityEvents } from './activity-event-builder'

const PANE_KEY = `tab-1:${LEAF_ID}`

function doneEntry(connectionId: string | null): AgentStatusEntry {
  return {
    state: 'done',
    prompt: 'Finished task',
    updatedAt: 2_000,
    stateStartedAt: 2_000,
    paneKey: PANE_KEY,
    tabId: 'tab-1',
    connectionId,
    stateHistory: [],
    agentType: 'claude'
  }
}

describe('activity event host ownership', () => {
  it('uses the status transport host when worktree and repo ids collide', () => {
    const localRepo = makeRepo()
    const remoteRepo = { ...makeRepo(), connectionId: 'builder', displayName: 'Remote repo' }
    const localWorktree = makeWorktree()
    const remoteWorktree = {
      ...makeWorktree(),
      hostId: 'ssh:builder' as const,
      displayName: 'Remote worktree'
    }
    const tab = makeTab()
    const resolveWorktree = vi.fn((_worktreeId, executionHostId) =>
      executionHostId === 'ssh:builder' ? remoteWorktree : localWorktree
    )

    const result = buildActivityEvents({
      agentStatusByPaneKey: { [PANE_KEY]: doneEntry('builder') },
      retainedAgentsByPaneKey: {},
      tabsByWorktree: { [localWorktree.id]: [tab] },
      worktreeMap: new Map([[localWorktree.id, localWorktree]]),
      repoMap: new Map([[localRepo.id, localRepo]]),
      repos: [localRepo, remoteRepo],
      resolveWorktree,
      acknowledgedAgentsByPaneKey: {},
      now: 3_000
    })

    expect(resolveWorktree).toHaveBeenCalledWith(localWorktree.id, 'ssh:builder')
    expect(result.events[0]?.worktree).toBe(remoteWorktree)
    expect(result.events[0]?.repo).toBe(remoteRepo)
  })

  it('uses the mirrored tab host when paired-runtime status is host-local', () => {
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
    const tab = makeTab()
    const resolveWorktree = vi.fn((_worktreeId, executionHostId) =>
      executionHostId === 'runtime:env-1' ? runtimeWorktree : localWorktree
    )

    const result = buildActivityEvents({
      agentStatusByPaneKey: { [PANE_KEY]: doneEntry(null) },
      retainedAgentsByPaneKey: {},
      tabsByWorktree: { [localWorktree.id]: [tab] },
      unifiedTabsByWorktree: {
        [localWorktree.id]: [
          {
            id: tab.id,
            entityId: tab.id,
            groupId: 'group-1',
            worktreeId: localWorktree.id,
            executionHostId: 'runtime:env-1',
            contentType: 'terminal',
            label: tab.title,
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      worktreeMap: new Map([[localWorktree.id, localWorktree]]),
      repoMap: new Map([[localRepo.id, localRepo]]),
      repos: [localRepo, runtimeRepo],
      resolveWorktree,
      acknowledgedAgentsByPaneKey: {},
      now: 3_000
    })

    expect(resolveWorktree).toHaveBeenCalledWith(localWorktree.id, 'runtime:env-1')
    expect(result.events[0]?.worktree).toBe(runtimeWorktree)
    expect(result.events[0]?.repo).toBe(runtimeRepo)
  })

  it('keeps retained folder-workspace activity after its terminal tab is gone', () => {
    const folderWorktree = {
      ...makeWorktree(),
      id: folderWorkspaceKey('folder-1'),
      repoId: 'folder-workspace:group-1',
      hostId: 'local' as const,
      displayName: 'Docs folder'
    }
    const tab = { ...makeTab(), worktreeId: folderWorktree.id }
    const retained = makeRetainedDoneEntry(tab)
    retained.worktreeId = folderWorktree.id
    retained.entry = doneEntry(null)

    const result = buildActivityEvents({
      agentStatusByPaneKey: {},
      retainedAgentsByPaneKey: { [PANE_KEY]: retained },
      tabsByWorktree: {},
      worktreeMap: new Map(),
      repoMap: new Map(),
      resolveWorktree: (worktreeId, executionHostId) =>
        worktreeId === folderWorktree.id && executionHostId === 'local'
          ? folderWorktree
          : undefined,
      acknowledgedAgentsByPaneKey: {},
      now: 3_000
    })

    expect(result.events[0]?.worktree).toBe(folderWorktree)
    expect(result.events[0]?.worktree.displayName).toBe('Docs folder')
  })

  it('carries migrationUnsupportedPtyId on events built for un-migratable panes', () => {
    const worktree = makeWorktree()
    const repo = makeRepo()
    const tab = makeTab()

    const result = buildActivityEvents({
      agentStatusByPaneKey: {},
      retainedAgentsByPaneKey: {},
      migrationUnsupportedByPtyId: {
        'pty-1': {
          ptyId: 'pty-1',
          paneKey: PANE_KEY,
          tabId: tab.id,
          reason: 'legacy-numeric-pane-key',
          source: 'local',
          updatedAt: 1_000
        }
      },
      tabsByWorktree: { [worktree.id]: [tab] },
      worktreeMap: new Map([[worktree.id, worktree]]),
      repoMap: new Map([[repo.id, repo]]),
      resolveWorktree: () => worktree,
      acknowledgedAgentsByPaneKey: {},
      now: 3_000
    })

    expect(result.events.length).toBeGreaterThan(0)
    for (const event of result.events) {
      expect(event.migrationUnsupportedPtyId).toBe('pty-1')
    }
  })

  it('uses the retained terminal handle to preserve runtime host ownership after teardown', () => {
    const localWorktree = makeWorktree()
    const runtimeWorktree = {
      ...makeWorktree(),
      hostId: 'runtime:env-1' as const,
      runtimeOwnerEnvironmentId: 'env-1',
      displayName: 'Runtime worktree'
    }
    const tab = { ...makeTab(), ptyId: null }
    const retained = makeRetainedDoneEntry(tab)
    retained.entry = { ...doneEntry(null), terminalHandle: 'remote:env-1@@pty-1' }
    const resolveWorktree = vi.fn((_worktreeId, executionHostId) =>
      executionHostId === 'runtime:env-1' ? runtimeWorktree : localWorktree
    )

    const result = buildActivityEvents({
      agentStatusByPaneKey: {},
      retainedAgentsByPaneKey: { [PANE_KEY]: retained },
      tabsByWorktree: {},
      worktreeMap: new Map([[localWorktree.id, localWorktree]]),
      repoMap: new Map(),
      resolveWorktree,
      acknowledgedAgentsByPaneKey: {},
      now: 3_000
    })

    expect(resolveWorktree).toHaveBeenCalledWith(localWorktree.id, 'runtime:env-1')
    expect(result.events[0]?.worktree).toBe(runtimeWorktree)
  })
})
