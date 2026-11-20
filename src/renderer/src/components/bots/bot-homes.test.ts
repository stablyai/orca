import { describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { selectSidebarChildrenByParentIdentity } from '@/store/slices/worktrees/metadata/cross-store-lineage-parents'
import type { Bot } from '../../../../shared/bot-types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host/execution-host'
import { indexHiddenProjects } from '../../../../shared/project/catalog/hidden-projects'
import { worktreeWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import {
  makeLineage,
  makeWorkspaceLineage
} from '@/store/slices/worktrees/metadata/workspace-lineage.test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { computeVisibleWorktrees } from '@/components/sidebar/worktree-list/listing/compute-visible-worktrees'
import { getWorktreeHostIdentity } from '../../../../shared/worktree/host-qualified-identity'
import {
  getBotHomes,
  getBotListedWorktreeIdentities,
  sortBotsBySidebarOrder
} from '../../../../shared/bots/bot-homes'

const bot: Bot = {
  id: 'bot-1',
  name: 'Ranger',
  hostId: 'local',
  folder: 'ranger',
  folderWorkspaceId: 'bot-home',
  agent: 'claude',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  chatSessionId: null,
  linear: null,
  github: null,
  createdAt: 1,
  updatedAt: 1
}

const home = makeFolderWorkspace({ id: 'bot-home' })
const worker = makeWorktree({ id: 'repo1::/worker', repoId: 'repo1', instanceId: 'w' })
const workerChild = makeWorktree({ id: 'repo1::/worker-child', repoId: 'repo1', instanceId: 'c' })
const handMade = makeWorktree({ id: 'repo1::/hand-made', repoId: 'repo1' })
const plain = makeWorktree({ id: 'repo1::/plain', repoId: 'repo1' })
const lineage = {
  workspaceLineageByChildKey: {
    [worktreeWorkspaceKey(worker.id)]: makeWorkspaceLineage({
      childWorkspaceKey: worktreeWorkspaceKey(worker.id),
      childInstanceId: null,
      parentWorkspaceKey: 'folder:bot-home',
      origin: 'orchestration'
    }),
    // Linked to the bot's home by hand; it is the bot's all the same.
    [worktreeWorkspaceKey(handMade.id)]: makeWorkspaceLineage({
      childWorkspaceKey: worktreeWorkspaceKey(handMade.id),
      childInstanceId: null,
      parentWorkspaceKey: 'folder:bot-home',
      origin: 'manual'
    })
  },
  worktreeLineageById: {
    [workerChild.id]: makeLineage({
      worktreeId: workerChild.id,
      worktreeInstanceId: 'c',
      parentWorktreeId: worker.id,
      parentWorktreeInstanceId: 'w'
    })
  },
  worktreesByRepo: { repo1: [worker, workerChild, handMade, plain] }
}

// The sidebar's children over these records, as the Bots section reads them.
function sidebarChildrenOf(records: typeof lineage) {
  return selectSidebarChildrenByParentIdentity({
    ...useAppStore.getState(),
    folderWorkspaces: [home],
    ...records
  })
}

describe('sortBotsBySidebarOrder', () => {
  it('lists unplaced bots newest first, then placed bots by their order, whatever the host order', () => {
    const named = (id: string, createdAt: number, sidebarOrder?: number) => ({
      id,
      createdAt,
      ...(sidebarOrder === undefined ? {} : { sidebarOrder })
    })
    // The host lists by last edit, so the newest-edited bot comes last.
    const listed = [named('b', 2), named('placed-1', 9, 1), named('a', 1), named('placed-0', 8, 0)]
    expect(sortBotsBySidebarOrder(listed).map((entry) => entry.id)).toEqual([
      'b',
      'a',
      'placed-0',
      'placed-1'
    ])
  })

  it('reads a phone’s loosely typed fields without trusting them', () => {
    const listed = [
      { id: 'odd', createdAt: 'soon', sidebarOrder: 'first' },
      { id: 'ok', createdAt: 1 }
    ]
    expect(sortBotsBySidebarOrder(listed).map((entry) => entry.id)).toEqual(['ok', 'odd'])
  })
})

describe('getBotListedWorktreeIdentities', () => {
  it('lists every workspace under its home and their children, however they got there', () => {
    const homes = getBotHomes([bot], [home, makeFolderWorkspace({ id: 'other' })])

    expect(homes.map((entry) => entry.home.id)).toEqual(['bot-home'])
    expect([...getBotListedWorktreeIdentities([home], sidebarChildrenOf(lineage))].sort()).toEqual(
      [
        getWorktreeHostIdentity(worker),
        getWorktreeHostIdentity(workerChild),
        getWorktreeHostIdentity(handMade)
      ].sort()
    )
  })

  it("leaves them out of their project's list, not a same-id workspace on another host", () => {
    const remoteTwin = makeWorktree({ id: worker.id, repoId: 'repo2', hostId: 'ssh:box' })
    const ids = [worker.id, workerChild.id, handMade.id, plain.id]
    const visible = computeVisibleWorktrees(
      { ...lineage.worktreesByRepo, repo2: [remoteTwin] },
      ids,
      {
        filterRepoIds: [],
        showSleepingWorkspaces: true,
        tabsByWorktree: {},
        ptyIdsByTabId: {},
        worktreeIdsWithLiveAgent: new Set(),
        hideDefaultBranchWorkspace: false,
        hideAutomationGeneratedWorkspaces: false,
        hideCliCreatedWorkspaces: false,
        hideDetachedHeadWorkspaces: false,
        hideWorkspacesFromOtherDevices: false,
        pairedDeviceIdsByEnvironment: new Map(),
        repoMap: new Map(),
        workspaceHostScope: 'all',
        defaultHostId: LOCAL_EXECUTION_HOST_ID,
        hiddenProjects: indexHiddenProjects([], LOCAL_EXECUTION_HOST_ID),
        worktreeLineageById: lineage.worktreeLineageById,
        botListedWorktreeIdentities: getBotListedWorktreeIdentities(
          [home],
          sidebarChildrenOf(lineage)
        )
      }
    )

    expect(visible.map((worktree) => [worktree.id, worktree.hostId])).toEqual(
      expect.arrayContaining([
        [plain.id, undefined],
        [worker.id, 'ssh:box']
      ])
    )
    expect(visible).toHaveLength(2)
  })
})
