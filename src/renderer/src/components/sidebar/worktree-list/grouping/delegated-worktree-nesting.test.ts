import { describe, expect, it } from 'vitest'
import { getSettingsFocusedExecutionHostId } from '../../../../../../shared/execution-host'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { buildRows } from './build-rows'
import { resolveDelegatedWorktreeNesting } from './delegated-worktree-nesting'
import { repo, remoteRepo, worktree } from '../../worktree-list-groups-test-fixtures'
import type { DelegatedWorktreeEdge } from '../../../../../../shared/worktree/delegated-worktree-edge'
import type { WorktreeLineage } from '../../../../../../shared/worktree/lineage-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import type {
  ImportedWorktreesCardCandidate,
  NewExternalWorktreesInboxCandidate,
  PendingCreationRef,
  Row
} from './row-types'

const REMOTE_HOST = 'runtime:env-1' as const

const coordinator: Worktree = {
  ...worktree,
  id: 'repo-1::/home/alex/orca/coordinator',
  hostId: 'local',
  instanceId: 'coordinator-instance',
  displayName: 'coordinator'
}

const remoteWorker: Worktree = {
  ...worktree,
  id: 'repo-remote::/home/ubuntu/orca/worker',
  repoId: remoteRepo.id,
  hostId: REMOTE_HOST,
  instanceId: 'worker-instance',
  displayName: 'worker'
}

// Why: a second, undelegated worktree in the child's repo is what gives that repo a
// section of its own, which is the case where the fallback rows could be emitted twice.
const remoteSibling: Worktree = {
  ...worktree,
  id: 'repo-remote::/home/ubuntu/orca/sibling',
  repoId: remoteRepo.id,
  hostId: REMOTE_HOST,
  instanceId: 'sibling-instance',
  displayName: 'sibling'
}

const otherRepo: Repo = { ...remoteRepo, id: 'repo-other', displayName: 'other' }

// Why: a second coordinator in a different repo section, with its own delegated child of the
// same remote repo — the case where two sections each claim that repo.
const otherCoordinator: Worktree = {
  ...worktree,
  id: 'repo-other::/home/alex/orca/other-coordinator',
  repoId: otherRepo.id,
  hostId: 'local',
  instanceId: 'other-coordinator-instance',
  displayName: 'other-coordinator'
}

const secondRemoteWorker: Worktree = {
  ...worktree,
  id: 'repo-remote::/home/ubuntu/orca/worker-2',
  repoId: remoteRepo.id,
  hostId: REMOTE_HOST,
  instanceId: 'worker-2-instance',
  displayName: 'worker-2'
}

const edge: DelegatedWorktreeEdge = {
  parentWorktreeId: coordinator.id,
  childHostId: REMOTE_HOST,
  childWorktreeId: remoteWorker.id,
  dispatchId: 'ctx_1'
}

function nest(args: {
  worktrees: readonly Worktree[]
  edges: readonly DelegatedWorktreeEdge[]
  lineageParentIdentity?: (worktree: Worktree) => string | undefined
}): ReadonlyMap<string, string> {
  return resolveDelegatedWorktreeNesting({
    worktrees: args.worktrees,
    edges: args.edges,
    homeHostId: 'local',
    getLineageParentIdentity: args.lineageParentIdentity ?? (() => undefined),
    resolveHostId: (candidate) => candidate.hostId ?? 'local'
  }).parentIdentityByChildIdentity
}

describe('resolveDelegatedWorktreeNesting', () => {
  it('nests a remote worker under the coordinator that dispatched it', () => {
    expect(nest({ worktrees: [coordinator, remoteWorker], edges: [edge] })).toEqual(
      new Map([[`${REMOTE_HOST}|${remoteWorker.id}`, `local|${coordinator.id}`]])
    )
  })

  it('ignores an edge whose coordinator row is not on this machine', () => {
    const elsewhere = { ...coordinator, hostId: 'runtime:env-2' as const }
    expect(nest({ worktrees: [elsewhere, remoteWorker], edges: [edge] }).size).toBe(0)
  })

  it('leaves git lineage in charge when the child already has a parent', () => {
    expect(
      nest({
        worktrees: [coordinator, remoteWorker],
        edges: [edge],
        lineageParentIdentity: (candidate) =>
          candidate.id === remoteWorker.id ? `${REMOTE_HOST}|repo-remote::/other` : undefined
      }).size
    ).toBe(0)
  })

  it('refuses an edge that would close a cycle', () => {
    const backEdge: DelegatedWorktreeEdge = {
      parentWorktreeId: coordinator.id,
      childHostId: REMOTE_HOST,
      childWorktreeId: remoteWorker.id,
      dispatchId: 'ctx_2'
    }
    // The coordinator already sits beneath the worker, so nesting the worker under it would
    // loop. The parent resolves here, so this reaches the cycle walk rather than an early exit.
    expect(
      nest({
        worktrees: [coordinator, remoteWorker],
        edges: [backEdge],
        lineageParentIdentity: (candidate) =>
          candidate.id === coordinator.id ? `${REMOTE_HOST}|${remoteWorker.id}` : undefined
      }).size
    ).toBe(0)
  })

  // A local worktree carries no hostId; the edge still names it through the resolved host.
  it('finds a local coordinator whose row has no hostId', () => {
    const unstamped: Worktree = { ...coordinator, hostId: undefined }
    expect(nest({ worktrees: [unstamped, remoteWorker], edges: [edge] })).toEqual(
      new Map([[`${REMOTE_HOST}|${remoteWorker.id}`, `|${coordinator.id}`]])
    )
  })

  // An SSH worktree reached through the paired runtime keeps its ssh host on the row, while
  // the dispatch recorded the runtime it went through.
  it('finds a worker on an SSH target reached through the paired runtime', () => {
    const sshWorker: Worktree = {
      ...remoteWorker,
      hostId: 'ssh:gpu-vm',
      runtimeOwnerEnvironmentId: 'env-1'
    }
    expect(nest({ worktrees: [coordinator, sshWorker], edges: [edge] })).toEqual(
      new Map([[`ssh:gpu-vm|${remoteWorker.id}`, `local|${coordinator.id}`]])
    )
  })

  it('keeps the first edge when a worktree was reused by a later dispatch', () => {
    const reused: DelegatedWorktreeEdge = {
      ...edge,
      parentWorktreeId: 'repo-1::/other',
      dispatchId: 'ctx_3'
    }
    expect(nest({ worktrees: [coordinator, remoteWorker], edges: [edge, reused] })).toEqual(
      new Map([[`${REMOTE_HOST}|${remoteWorker.id}`, `local|${coordinator.id}`]])
    )
  })
})

function findItem(
  rows: readonly Row[],
  worktreeId: string
): Extract<Row, { type: 'item' }> | undefined {
  return rows.find(
    (row): row is Extract<Row, { type: 'item' }> =>
      row.type === 'item' && row.worktree.id === worktreeId
  )
}

describe('buildRows with delegated edges', () => {
  const repoMapWithRemote = new Map([
    [repo.id, repo],
    [remoteRepo.id, remoteRepo],
    [otherRepo.id, otherRepo]
  ])
  const lineage: Record<string, WorktreeLineage> = {}

  function rowsFor(
    edges: readonly DelegatedWorktreeEdge[],
    overrides: {
      defaultHostId?: ExecutionHostId
      importedWorktreesByRepo?: ReadonlyMap<string, ImportedWorktreesCardCandidate>
      newExternalWorktreesInboxByRepo?: ReadonlyMap<string, NewExternalWorktreesInboxCandidate>
      pendingCreations?: readonly PendingCreationRef[]
      extraWorktrees?: readonly Worktree[]
      coordinator?: Worktree
      repoOrder?: Map<string, number>
    } = {}
  ) {
    const worktrees = [
      overrides.coordinator ?? coordinator,
      remoteWorker,
      ...(overrides.extraWorktrees ?? [])
    ]
    return buildRows(
      'repo',
      worktrees,
      repoMapWithRemote,
      null,
      new Set(),
      overrides.repoOrder,
      undefined,
      'manual',
      lineage,
      new Map(worktrees.map((w) => [w.id, w])),
      true,
      undefined,
      [],
      new Set(),
      overrides.importedWorktreesByRepo ?? new Map(),
      overrides.newExternalWorktreesInboxByRepo ?? new Map(),
      overrides.pendingCreations ?? [],
      undefined,
      [],
      undefined,
      overrides.defaultHostId ?? 'local',
      'single-location',
      edges
    )
  }

  it('renders the remote worker nested inside the coordinator repo section', () => {
    const rows = rowsFor([edge])
    const worker = findItem(rows, remoteWorker.id)
    const parent = findItem(rows, coordinator.id)
    expect(worker).toMatchObject({ depth: 1, sectionKey: parent?.sectionKey })
    expect(parent).toMatchObject({ depth: 0, lineageChildCount: 1 })
    expect(
      rows.filter((row) => row.type === 'item' && row.worktree.id === remoteWorker.id)
    ).toHaveLength(1)
  })

  it('still nests while a remote runtime environment is the focused host', () => {
    // Focus is a filter over every host's rows; the edges still come from this
    // window's own runtime, so the coordinator is still looked up as a local row.
    const rows = rowsFor([edge], {
      defaultHostId: getSettingsFocusedExecutionHostId({ activeRuntimeEnvironmentId: 'env-1' })
    })
    expect(findItem(rows, remoteWorker.id)).toMatchObject({ depth: 1 })
  })

  // Local rows are left unqualified by the listing, so the real resolver must place them.
  it('nests under a local coordinator whose row has no hostId', () => {
    const unstamped: Worktree = { ...coordinator, hostId: undefined }
    const rows = rowsFor([edge], { coordinator: unstamped })
    expect(findItem(rows, remoteWorker.id)).toMatchObject({
      depth: 1,
      sectionKey: findItem(rows, coordinator.id)?.sectionKey
    })
  })

  // The worker's repo joins the coordinator's section for its notice rows only; it must not
  // pull that section to its own place in the manual order.
  it("keeps the coordinator section at the coordinator repo's position", () => {
    const repoOrder = new Map([
      [remoteRepo.id, 0],
      [otherRepo.id, 1],
      [repo.id, 2]
    ])
    const rows = rowsFor([edge], { extraWorktrees: [otherCoordinator], repoOrder })
    const headers = rows.filter((row) => row.type === 'header').map((row) => row.key)
    expect(headers).toEqual([
      findItem(rows, otherCoordinator.id)?.sectionKey,
      findItem(rows, coordinator.id)?.sectionKey
    ])
  })

  it('leaves the remote worker top-level in its own section without an edge', () => {
    const rows = rowsFor([])
    const worker = findItem(rows, remoteWorker.id)
    const parent = findItem(rows, coordinator.id)
    expect(worker).toMatchObject({ depth: 0 })
    expect(worker?.sectionKey).not.toBe(parent?.sectionKey)
  })

  it("renders the anchored child repo's fallback rows once, in the section that shows it", () => {
    const rows = rowsFor([edge], {
      importedWorktreesByRepo: new Map([
        [remoteRepo.id, { repo: remoteRepo, hiddenWorktrees: [] }]
      ]),
      newExternalWorktreesInboxByRepo: new Map([
        [remoteRepo.id, { repo: remoteRepo, inboxWorktrees: [] }]
      ]),
      pendingCreations: [{ creationId: 'create-1', repoId: remoteRepo.id }]
    })
    const coordinatorSection = findItem(rows, coordinator.id)?.sectionKey
    const headers = rows.filter((row) => row.type === 'header')
    // One section, not two: the child's repo has no section of its own to fall back to.
    expect(headers.map((header) => header.key)).toEqual([coordinatorSection])
    expect(rows.filter((row) => row.type === 'imported-worktrees-card')).toHaveLength(1)
    expect(rows.filter((row) => row.type === 'new-external-worktrees-inbox')).toHaveLength(1)
    expect(rows.filter((row) => row.type === 'pending-creation')).toHaveLength(1)
  })

  it("emits the child repo's fallback rows once when that repo has its own section", () => {
    const rows = rowsFor([edge], {
      extraWorktrees: [remoteSibling],
      importedWorktreesByRepo: new Map([
        [remoteRepo.id, { repo: remoteRepo, hiddenWorktrees: [] }]
      ]),
      newExternalWorktreesInboxByRepo: new Map([
        [remoteRepo.id, { repo: remoteRepo, inboxWorktrees: [] }]
      ]),
      pendingCreations: [{ creationId: 'create-1', repoId: remoteRepo.id }]
    })
    const coordinatorSection = findItem(rows, coordinator.id)?.sectionKey
    const siblingSection = findItem(rows, remoteSibling.id)?.sectionKey
    // The child's repo has a section of its own here, so the coordinator section must not
    // also claim it — the repo-keyed row ids are identical and would collide.
    expect(siblingSection).not.toBe(coordinatorSection)
    expect(rows.filter((row) => row.type === 'imported-worktrees-card')).toHaveLength(1)
    expect(rows.filter((row) => row.type === 'new-external-worktrees-inbox')).toHaveLength(1)
    expect(rows.filter((row) => row.type === 'pending-creation')).toHaveLength(1)
    // The repo-keyed notice rows carry the same id in whichever section emits them, so a
    // second emission is a duplicate React key, not just a redundant card.
    const noticeKeys = rows
      .filter(
        (row) =>
          row.type === 'imported-worktrees-card' ||
          row.type === 'new-external-worktrees-inbox' ||
          row.type === 'pending-creation'
      )
      .map((row) => row.key)
    expect(new Set(noticeKeys).size).toBe(noticeKeys.length)
  })

  it('leaves one claim when two coordinators in different sections anchor the same repo', () => {
    const secondEdge: DelegatedWorktreeEdge = {
      parentWorktreeId: otherCoordinator.id,
      childHostId: REMOTE_HOST,
      childWorktreeId: secondRemoteWorker.id,
      dispatchId: 'ctx_2'
    }
    const rows = rowsFor([edge, secondEdge], {
      extraWorktrees: [otherCoordinator, secondRemoteWorker],
      importedWorktreesByRepo: new Map([
        [remoteRepo.id, { repo: remoteRepo, hiddenWorktrees: [] }]
      ]),
      newExternalWorktreesInboxByRepo: new Map([
        [remoteRepo.id, { repo: remoteRepo, inboxWorktrees: [] }]
      ]),
      pendingCreations: [{ creationId: 'create-1', repoId: remoteRepo.id }]
    })
    // Both coordinators bucket a child of remoteRepo, so both claimed it. Only one may keep
    // the claim, or the repo-keyed notice rows are emitted from each section.
    expect(rows.filter((row) => row.type === 'imported-worktrees-card')).toHaveLength(1)
    expect(rows.filter((row) => row.type === 'new-external-worktrees-inbox')).toHaveLength(1)
    expect(rows.filter((row) => row.type === 'pending-creation')).toHaveLength(1)
  })
})
