import { describe, expect, it } from 'vitest'
import type { Tab } from '../../../../shared/tab-types'
import { toRemoteRuntimePtyId } from '../../../../shared/remote-runtime-pty-id'
import { toAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { buildActivityEvents } from './activity-event-builder'
import { buildAgentPaneThreads } from './activity-thread-builder'
import { getActivityThreadExecutionHostId } from './activity-thread-host'
import {
  makeRepo,
  makeTab,
  makeWorkingEntryWithoutHistory,
  makeWorktree,
  PANE_KEY
} from './ActivityPrototypePage-test-fixtures'

// The same worktree id exists locally and on a paired server; only the session's own stamps say which one it ran on.
function buildThread(args: {
  tabHostId?: Tab['executionHostId']
  ptyId?: string | null
  connectionId?: string | null
  resolveRuntimeWorktree?: boolean
}) {
  const localRepo = makeRepo()
  const runtimeRepo = { ...makeRepo(), executionHostId: 'runtime:env-1' as const }
  const localWorktree = makeWorktree()
  const runtimeWorktree = { ...makeWorktree(), hostId: 'runtime:env-1' as const }
  const unifiedTab: Tab = {
    id: 'tab-1',
    entityId: 'tab-1',
    groupId: 'group-1',
    worktreeId: 'wt-1',
    ...(args.tabHostId ? { executionHostId: args.tabHostId } : {}),
    contentType: 'terminal',
    label: 'Claude',
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
  const result = buildActivityEvents({
    agentStatusByPaneKey: {
      [PANE_KEY]: {
        ...makeWorkingEntryWithoutHistory(),
        ...(args.connectionId !== undefined ? { connectionId: args.connectionId } : {})
      }
    },
    retainedAgentsByPaneKey: {},
    tabsByWorktree: { 'wt-1': [{ ...makeTab(), ptyId: args.ptyId ?? null }] },
    unifiedTabsByWorktree: { 'wt-1': [unifiedTab] },
    worktreeMap: new Map([[localWorktree.id, localWorktree]]),
    repoMap: new Map([[localRepo.id, localRepo]]),
    repos: [localRepo, runtimeRepo],
    resolveWorktree: args.resolveRuntimeWorktree
      ? (_id, hostId) => (hostId === 'runtime:env-1' ? runtimeWorktree : localWorktree)
      : () => undefined,
    acknowledgedAgentsByPaneKey: {},
    now: 3_000
  })
  const [thread] = buildAgentPaneThreads(result)
  return thread
}

describe('activity thread session host', () => {
  it('keeps a stamped paired-server session on that server when only the local twin is cataloged', () => {
    const thread = buildThread({ tabHostId: 'runtime:env-1' })

    expect(thread.worktree.hostId).toBeUndefined()
    expect(getActivityThreadExecutionHostId(thread)).toBe('runtime:env-1')
  })

  it('names the paired server from a remote runtime PTY id', () => {
    const thread = buildThread({ ptyId: toRemoteRuntimePtyId('handle-1', 'env-1') })

    expect(getActivityThreadExecutionHostId(thread)).toBe('runtime:env-1')
  })

  it('names the SSH target from an SSH PTY id', () => {
    const thread = buildThread({ ptyId: toAppSshPtyId('builder', 'relay-1') })

    expect(getActivityThreadExecutionHostId(thread)).toBe('ssh:builder')
  })

  it('does not trust a relative local stamp or a status-entry connection id over the workspace owner', () => {
    const localStamped = buildThread({ tabHostId: 'local', resolveRuntimeWorktree: true })
    const nestedSsh = buildThread({ connectionId: 'builder' })

    expect(localStamped.executionHostId).toBeUndefined()
    expect(nestedSsh.executionHostId).toBeUndefined()
  })

  it('falls back to the workspace owner when the session names no host', () => {
    const thread = buildThread({ resolveRuntimeWorktree: false })

    expect(getActivityThreadExecutionHostId(thread)).toBe('local')
  })
})
