import { describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import { makeLineage } from '@/store/slices/worktrees/metadata/workspace-lineage.test-fixture'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { worktreeWorkspaceKey } from '../../../shared/workspace/identity/workspace-scope'
import { getFolderWorkspaceChildWorktrees } from '../../../shared/folder-workspace-child-worktrees'
import { getBotListedWorktreeIdentities } from '../../../shared/bots/bot-homes'
import { selectSidebarChildrenByParentIdentity } from './slices/worktrees/metadata/cross-store-lineage-parents'
import { getFolderWorkspaceHostIdentity } from '../../../shared/folder-workspaces/folder-workspace-worktree'
import { selectFolderAncestors } from '@/components/bots/use-worktree-bot'
import { getFolderWorkspaceCardPrDisplay } from '@/components/sidebar/workspace-card/review/folder-workspace-card-pr-display'

type Row = ReturnType<typeof makeWorktree>

function record(
  child: Row,
  parentInstallationId: string,
  parentKey: string,
  parentInstance: string
) {
  return {
    childWorkspaceKey: worktreeWorkspaceKey(child.id),
    childInstanceId: child.instanceId,
    parent: {
      installationId: parentInstallationId,
      workspaceKey: parentKey,
      instanceId: parentInstance
    },
    origin: 'orchestration',
    capture: { source: 'orchestration-context', confidence: 'explicit' },
    createdAt: 1
  }
}

// A bot home here, its worker on a paired Windows server, and that worker's child back here;
// a third paired server is known but holds nothing yet.
function crossMachineState(workerCount = 1) {
  const workers = Array.from({ length: workerCount }, (_, index) =>
    makeWorktree({
      id: `remote-${index}`,
      repoId: 'remote-repo',
      hostId: 'runtime:windows-2',
      runtimeOwnerEnvironmentId: 'windows-2',
      instanceId: `remote-instance-${index}`
    })
  )
  const grandchild = makeWorktree({
    id: 'local-grandchild',
    repoId: 'local-repo',
    hostId: 'local',
    instanceId: 'local-grandchild-instance'
  })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: lineage selectors read only installationId from the partial status and the record fields set here.
  return {
    ...useAppStore.getState(),
    folderWorkspaces: [makeFolderWorkspace({ id: 'bot-home' })],
    workspaceLineageByChildKey: {},
    worktreeLineageById: {},
    worktreesByRepo: { 'remote-repo': workers, 'local-repo': [grandchild] },
    ownLineageInstallationId: 'this-mac',
    removedRuntimeEnvironmentIds: new Set<string>(),
    runtimeStatusByEnvironmentId: new Map([
      ['windows-2', { status: { hostDescriptor: { installationId: 'windows-install' } } }],
      ['third', { status: { hostDescriptor: { installationId: 'third-install' } } }]
    ]),
    crossStoreLineageByStoreKey: {
      'windows-2': Object.fromEntries(
        workers.map((worker) => [
          worktreeWorkspaceKey(worker.id),
          record(worker, 'this-mac', 'folder:bot-home', 'bot-home')
        ])
      ),
      '': {
        [worktreeWorkspaceKey(grandchild.id)]: record(
          grandchild,
          'windows-install',
          'worktree:remote-0',
          'remote-instance-0'
        )
      }
    }
  } as unknown as ReturnType<typeof useAppStore.getState>
}

describe('selectSidebarChildrenByParentIdentity', () => {
  it("lists a bot worker's child on another machine under that worker", () => {
    const state = crossMachineState()
    const { childWorktrees, lineageChildrenByParentIdentity } = getFolderWorkspaceChildWorktrees(
      getFolderWorkspaceHostIdentity(state.folderWorkspaces[0]),
      selectSidebarChildrenByParentIdentity(state, state.runtimeStatusByEnvironmentId)
    )
    expect(childWorktrees.map((row) => row.id)).toEqual(['remote-0'])
    expect(
      lineageChildrenByParentIdentity.get('runtime:windows-2|remote-0')?.map((row) => row.id)
    ).toEqual(['local-grandchild'])
  })

  it('keeps its identity when a status update keeps every store identity', () => {
    const state = crossMachineState(1000)
    const sources = selectSidebarChildrenByParentIdentity(state, state.runtimeStatusByEnvironmentId)
    expect(sources.get(getFolderWorkspaceHostIdentity(state.folderWorkspaces[0]))).toHaveLength(
      1000
    )
    const statusOnly = {
      ...state,
      runtimeStatusByEnvironmentId: new Map(state.runtimeStatusByEnvironmentId)
    }
    expect(
      selectSidebarChildrenByParentIdentity(statusOnly, statusOnly.runtimeStatusByEnvironmentId)
    ).toBe(sources)
  })

  it('keeps each same-id worker’s child on another machine under its own worker', () => {
    const state = crossMachineState()
    const third = makeWorktree({
      id: 'remote-0',
      repoId: 'third-repo',
      hostId: 'runtime:third',
      runtimeOwnerEnvironmentId: 'third',
      instanceId: 'third-worker-instance'
    })
    const otherChild = makeWorktree({
      id: 'other-grandchild',
      repoId: 'local-repo',
      hostId: 'local',
      instanceId: 'other-grandchild-instance'
    })
    const twins = {
      ...state,
      worktreesByRepo: {
        ...state.worktreesByRepo,
        'third-repo': [third],
        'local-repo': [...state.worktreesByRepo['local-repo'], otherChild]
      },
      crossStoreLineageByStoreKey: {
        ...state.crossStoreLineageByStoreKey,
        third: {
          [worktreeWorkspaceKey(third.id)]: record(third, 'this-mac', 'folder:bot-home', 'bot-home')
        },
        '': {
          ...state.crossStoreLineageByStoreKey[''],
          [worktreeWorkspaceKey(otherChild.id)]: record(
            otherChild,
            'third-install',
            'worktree:remote-0',
            'third-worker-instance'
          )
        }
      }
    }
    const identities = getBotListedWorktreeIdentities(
      twins.folderWorkspaces,
      selectSidebarChildrenByParentIdentity(twins, twins.runtimeStatusByEnvironmentId)
    )
    expect([...identities].sort()).toEqual([
      'local|local-grandchild',
      'local|other-grandchild',
      'runtime:third|remote-0',
      'runtime:windows-2|remote-0'
    ])
  })
})

describe('folder cards and badges over the sidebar children', () => {
  function cardPr(state: ReturnType<typeof crossMachineState>, row: Row, number: number) {
    return getFolderWorkspaceCardPrDisplay({
      folderIdentity: getFolderWorkspaceHostIdentity(state.folderWorkspaces[0]),
      childrenByParentIdentity: selectSidebarChildrenByParentIdentity(
        state,
        state.runtimeStatusByEnvironmentId
      ),
      repoMap: new Map([
        [
          row.repoId,
          { id: row.repoId, path: '/repo', displayName: row.repoId, addedAt: 1, badgeColor: '#000' }
        ]
      ]),
      hostedReviewCache: null,
      prCache: {
        [`${row.repoId}::${row.branch.replace('refs/heads/', '')}`]: {
          data: {
            number,
            title: 'Review',
            state: 'open',
            url: 'https://example.test/pull/1',
            checksStatus: 'failure',
            updatedAt: '',
            mergeable: 'UNKNOWN'
          },
          fetchedAt: 1
        }
      }
    })
  }

  it("shows a PR from a worker's child on another machine", () => {
    const state = crossMachineState()
    const grandchild = { ...state.worktreesByRepo['local-repo'][0], linkedPR: 74 }
    const changed = {
      ...state,
      worktreesByRepo: { ...state.worktreesByRepo, 'local-repo': [grandchild] }
    }
    expect(cardPr(changed, grandchild, 74)?.number).toBe(74)
  })

  it('leaves out a PR from a workspace the sidebar nests under its worktree parent instead', () => {
    const state = crossMachineState()
    const worker = { ...state.worktreesByRepo['remote-repo'][0], linkedPR: 73 }
    const parent = makeWorktree({
      id: 'other-root',
      repoId: 'remote-repo',
      hostId: 'runtime:windows-2',
      instanceId: 'other-instance'
    })
    const changed = {
      ...state,
      worktreesByRepo: { 'remote-repo': [worker, parent] },
      worktreeLineageById: {
        [worker.id]: makeLineage({
          worktreeId: worker.id,
          worktreeInstanceId: worker.instanceId,
          parentWorktreeId: parent.id,
          parentWorktreeInstanceId: parent.instanceId
        })
      }
    }
    expect(cardPr(changed, worker, 73)).toBeNull()
  })

  it("finds the bot home above a worker's child", () => {
    const state = crossMachineState()
    for (const row of [
      state.worktreesByRepo['remote-repo'][0],
      state.worktreesByRepo['local-repo'][0]
    ]) {
      expect(
        selectFolderAncestors(state, state.runtimeStatusByEnvironmentId, row).map(
          (folder) => folder.id
        )
      ).toEqual(['bot-home'])
    }
  })
})
