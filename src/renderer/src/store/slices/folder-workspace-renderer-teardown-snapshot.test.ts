import { describe, expect, it } from 'vitest'
import { toSshExecutionHostId } from '../../../../shared/execution-host'
import { toAppSshPtyId } from '../../../../shared/ssh-pty-id'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { makeTab } from './store-test-helpers'
import { snapshotFolderWorkspaceRendererTeardown } from './folder-workspace-renderer-teardown'

describe('folder workspace renderer teardown snapshot', () => {
  it('collects a direct-SSH live ledger PTY without retiring its mixed tab', () => {
    const workspaceKey = folderWorkspaceKey('shared')
    const tabId = 'mixed-tab'
    const ownerTargetId = 'ssh-owner'
    const siblingPtyId = toAppSshPtyId('ssh-sibling', 'sibling-pty')
    const ownerPtyId = toAppSshPtyId(ownerTargetId, 'owner-pty')
    const state = {
      tabsByWorktree: {
        [workspaceKey]: [makeTab({ id: tabId, worktreeId: workspaceKey, ptyId: siblingPtyId })]
      },
      ptyIdsByTabId: { [tabId]: [siblingPtyId] },
      terminalLayoutsByTabId: {},
      lastKnownRelayPtyIdByTabId: {},
      deferredSshSessionIdsByTabId: {},
      directSshLivePtyBindingByTabId: {
        [tabId]: {
          attemptId: 'attempt' as never,
          authority: {
            targetId: ownerTargetId,
            providerEpoch: 'epoch' as never,
            connectionGeneration: 1
          },
          tabGeneration: 1,
          ptyId: ownerPtyId
        }
      },
      pendingReconnectPtyIdByTabId: {},
      activeWorktreeId: null,
      activeWorkspaceKey: null,
      activeWorkspaceExecutionHostId: null,
      activeTabId: null,
      restoredRuntimeHostIdByWorkspaceSessionKey: {}
    }

    const snapshots = snapshotFolderWorkspaceRendererTeardown(state, [], {
      kind: 'ssh',
      hostId: toSshExecutionHostId(ownerTargetId),
      targetId: ownerTargetId,
      workspaceKeys: [workspaceKey]
    })

    expect(snapshots).toHaveLength(1)
    expect(new Set(snapshots[0]?.ptyIds)).toEqual(new Set([siblingPtyId, ownerPtyId]))
    expect(snapshots[0]?.retireTabIds).toEqual([])
  })
})
