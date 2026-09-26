import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import {
  toRuntimeExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { RemoteWorkspaceTestimonyState } from './remote-workspace-host-testimony'
import { shadowRowsTheHostHasNotAnswered } from './workspace-session-host-shadow-testimony'
import type { HostSessionSlices } from './workspace-session-host-split'

const TARGET_ID = 'target-1'
const SSH_HOST_ID: ExecutionHostId = toSshExecutionHostId(TARGET_ID)

function tab(id: string, worktreeId: string): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function sessionWithTabs(entries: Record<string, TerminalTab[]>): WorkspaceSessionState {
  return { ...getDefaultWorkspaceSession(), tabsByWorktree: entries }
}

describe('shadowRowsTheHostHasNotAnswered', () => {
  it('keeps a parked folder workspace even after the host answers, because the direct-SSH snapshot never replaces folder rows', () => {
    const answeredState: RemoteWorkspaceTestimonyState = {
      remoteWorkspaceHydratedTargetIds: new Set([TARGET_ID]),
      remoteWorkspaceSyncStatusByTargetId: {
        [TARGET_ID]: { phase: 'synced', direction: 'pull' }
      }
    }

    const folderKey = 'folder:folder-uuid-1'
    const worktreeKey = 'worktree:repo-1::worktree-1'
    const folderTabs = [tab('tab-folder', folderKey)]
    const worktreeTabs = [tab('tab-worktree', worktreeKey)]

    const shadow: HostSessionSlices = {
      [SSH_HOST_ID]: sessionWithTabs({
        [folderKey]: folderTabs,
        [worktreeKey]: worktreeTabs
      })
    }

    const result = shadowRowsTheHostHasNotAnswered(shadow, answeredState)

    expect(result).toBeDefined()
    const hostSlice = result?.[SSH_HOST_ID]
    expect(hostSlice).toBeDefined()
    expect(hostSlice?.tabsByWorktree).toEqual({
      [folderKey]: folderTabs
    })
    expect(hostSlice?.tabsByWorktree).not.toHaveProperty(worktreeKey)
  })

  it('keeps parked rows while the landed snapshot is in conflict', () => {
    const conflictState: RemoteWorkspaceTestimonyState = {
      remoteWorkspaceHydratedTargetIds: new Set([TARGET_ID]),
      remoteWorkspaceSyncStatusByTargetId: {
        [TARGET_ID]: { phase: 'conflict' }
      }
    }

    const worktreeKey = 'worktree:repo-1::worktree-1'
    const worktreeTabs = [tab('tab-worktree', worktreeKey)]

    const shadow: HostSessionSlices = {
      [SSH_HOST_ID]: sessionWithTabs({
        [worktreeKey]: worktreeTabs
      })
    }

    const result = shadowRowsTheHostHasNotAnswered(shadow, conflictState)

    // When the snapshot is in conflict, the host has not answered, so shadow is kept untouched by reference
    expect(result).toBe(shadow)
    expect(result?.[SSH_HOST_ID]?.tabsByWorktree).toEqual({
      [worktreeKey]: worktreeTabs
    })
  })

  it('keeps parked rows for a runtime host, which publishes no remote-workspace snapshot', () => {
    const envId = 'runtime-env-1'
    const runtimeHostId: ExecutionHostId = toRuntimeExecutionHostId(envId)

    // Even if runtime id happened to be in testimony state, runtime hosts do not use direct-SSH snapshots
    const state: RemoteWorkspaceTestimonyState = {
      remoteWorkspaceHydratedTargetIds: new Set([envId]),
      remoteWorkspaceSyncStatusByTargetId: {
        [envId]: { phase: 'synced', direction: 'pull' }
      }
    }

    const worktreeKey = 'worktree:repo-1::worktree-1'
    const worktreeTabs = [tab('tab-runtime', worktreeKey)]

    const shadow: HostSessionSlices = {
      [runtimeHostId]: sessionWithTabs({
        [worktreeKey]: worktreeTabs
      })
    }

    const result = shadowRowsTheHostHasNotAnswered(shadow, state)

    expect(result).toBe(shadow)
    expect(result?.[runtimeHostId]?.tabsByWorktree).toEqual({
      [worktreeKey]: worktreeTabs
    })
  })

  it('drops the host entry entirely when every parked row on it was answered for', () => {
    const answeredState: RemoteWorkspaceTestimonyState = {
      remoteWorkspaceHydratedTargetIds: new Set([TARGET_ID]),
      remoteWorkspaceSyncStatusByTargetId: {
        [TARGET_ID]: { phase: 'synced', direction: 'pull' }
      }
    }

    const worktreeKey = 'worktree:repo-1::worktree-1'
    const worktreeTabs = [tab('tab-worktree', worktreeKey)]

    const shadow: HostSessionSlices = {
      [SSH_HOST_ID]: sessionWithTabs({
        [worktreeKey]: worktreeTabs
      })
    }

    const result = shadowRowsTheHostHasNotAnswered(shadow, answeredState)

    expect(result).toBeDefined()
    expect(result?.[SSH_HOST_ID]).toBeUndefined()
    expect(Object.keys(result ?? {})).toEqual([])
  })

  it('keeps non-terminal fields such as openFilesByWorktree even after the host answers, because direct-SSH snapshots only project terminal state', () => {
    // Pullfrog finding 6: direct-SSH snapshots project terminal state only
    // (remote-workspace-snapshot-apply.ts:201). A parked row for openFilesByWorktree (and its
    // unsaved dirtyDraftContent) was never in the host's terminal snapshot and never superseded by
    // it, so host testimony must not withhold it from the shadow.
    const answeredState: RemoteWorkspaceTestimonyState = {
      remoteWorkspaceHydratedTargetIds: new Set([TARGET_ID]),
      remoteWorkspaceSyncStatusByTargetId: {
        [TARGET_ID]: { phase: 'synced', direction: 'pull' }
      }
    }

    const worktreeKey = 'worktree:repo-1::worktree-1'
    const worktreeTabs = [tab('tab-worktree', worktreeKey)]
    const openFiles = [
      {
        filePath: '/srv/app/index.ts',
        relativePath: 'index.ts',
        worktreeId: worktreeKey,
        language: 'typescript'
      }
    ]

    const shadow: HostSessionSlices = {
      [SSH_HOST_ID]: {
        ...sessionWithTabs({ [worktreeKey]: worktreeTabs }),
        openFilesByWorktree: { [worktreeKey]: openFiles as never }
      }
    }

    const result = shadowRowsTheHostHasNotAnswered(shadow, answeredState)

    expect(result).toBeDefined()
    const hostSlice = result?.[SSH_HOST_ID]
    expect(hostSlice).toBeDefined()
    // Terminal tabs for worktreeKey are withheld (superseded by testimony):
    expect(hostSlice?.tabsByWorktree).toBeUndefined()
    // Non-terminal openFilesByWorktree row survives:
    expect(hostSlice?.openFilesByWorktree).toEqual({
      [worktreeKey]: openFiles
    })
  })
})
