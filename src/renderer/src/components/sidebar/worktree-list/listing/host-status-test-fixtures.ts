import type { useVisibleSidebarWorktrees } from './use-visible-worktrees'
import type { useSidebarSectionRows } from './use-section-rows'
import { makeRepo, makeWorktree } from '../../../worktree-jump-palette-test-fixtures'
import type { Repo } from '../../../../../../shared/repo-types'
import { toRuntimeExecutionHostId } from '../../../../../../shared/execution-host'
import { useAppStore } from '@/store'
import { createCompatibleRuntimeStatusResponse } from '@/runtime/runtime-compatibility-test-fixture'
import type { RuntimeHostStatusSnapshot } from '../../../../../../shared/runtime-host-status'
import type { PublicKnownRuntimeEnvironment } from '../../../../../../shared/runtime-environments'
import type { SshConnectionStatus } from '../../../../../../shared/ssh-types'
import type { RuntimeStatus } from '../../../../../../shared/runtime-types'
export function environment(id: string, pairedDeviceId?: string): PublicKnownRuntimeEnvironment {
  return {
    id,
    name: id,
    pairedDeviceId,
    createdAt: 1,
    updatedAt: 1,
    pairingRevision: 1,
    lastUsedAt: null,
    runtimeId: null,
    endpoints: [],
    preferredEndpointId: id
  }
}
export function status(id: string): RuntimeStatus {
  const response = createCompatibleRuntimeStatusResponse(id)
  if (!response.ok) {
    throw new Error('Expected compatible status')
  }
  return response.result
}
export function publish(
  id: string,
  sequence: number,
  patch: Partial<RuntimeHostStatusSnapshot> = {}
) {
  useAppStore.getState().applyRuntimeHostStatusSnapshot({
    environmentId: id,
    pairingRevision: 1,
    sequence,
    checkedAt: sequence,
    status: status(id),
    verification: 'verified',
    transport: 'ready',
    ...patch
  })
}
export function ssh(status: SshConnectionStatus, targetId = 'target') {
  return { targetId, status, error: null, reconnectAttempt: 0 }
}

export function countArrayEntries<T>(values: readonly T[], visit: () => void): T[] {
  const entries = [...values]
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!
    Object.defineProperty(entries, index, {
      get: () => {
        visit()
        return entry
      }
    })
  }
  return entries
}
export function countMapEntries<K, V>(values: ReadonlyMap<K, V>, visit: () => void): Map<K, V> {
  const entries = new Map(values)
  const keys = entries.keys.bind(entries)
  const items = entries.values.bind(entries)
  entries.keys = function* () {
    for (const key of keys()) {
      visit()
      yield key
    }
    return undefined
  }
  entries.values = function* () {
    for (const item of items()) {
      visit()
      yield item
    }
    return undefined
  }
  return entries
}

export const repo = { ...makeRepo(), executionHostId: 'runtime:A' as const, connectionId: 'target' }
export const repoMap = new Map<string, Repo>([[repo.id, repo]])
export const worktree = makeWorktree('workspace', 'Workspace', {
  runtimeOwnerEnvironmentId: 'A',
  creatorProvenance: { kind: 'paired-device', deviceId: 'mine' }
})
export const visibilityArgs: Parameters<typeof useVisibleSidebarWorktrees>[0] = {
  filterState: {
    showSleepingWorkspaces: true,
    filterRepoIds: [],
    hideDefaultBranchWorkspace: false,
    hideAutomationGeneratedWorkspaces: false,
    hideCliCreatedWorkspaces: false,
    hideDetachedHeadWorkspaces: false,
    hideWorkspacesFromOtherDevices: false,
    alwaysShowDefaultBranchWorkspace: true,
    visibleWorkspaceHostIds: null,
    workspaceHostScope: 'all'
  },
  sortBy: 'recent',
  sortedIds: [worktree.id],
  repoMap,
  worktreeLineageById: {},
  defaultHostId: 'local',
  agentSendTargetWorktreeId: null
}
export function sectionArgs(): Parameters<typeof useSidebarSectionRows>[0] {
  return {
    groupBy: 'repo',
    projectOrderBy: 'manual',
    pinnedDisplayPolicy: 'single-location',
    defaultHostId: 'local',
    worktrees: [worktree],
    repos: [repo],
    repoMap,
    worktreeMap: new Map([[worktree.id, worktree]]),
    worktreeLineageById: {},
    prCache: null,
    settings: useAppStore.getState().settings,
    workspaceStatuses: [],
    effectiveCollapsedGroups: new Set(),
    projectGrouping: { projects: [], projectHostSetups: [] },
    visibleReposForRows: [repo],
    visibleProjectGroupsForRows: [],
    visibleFolderWorkspacesForRows: [],
    importedWorktreesByRepo: new Map(),
    newExternalWorktreesInboxByRepo: new Map(),
    filterRepoIds: [],
    visibleWorkspaceHostIds: null,
    workspaceHostScope: 'all'
  }
}

export function sidebarCorpus(repoCount: number, hostCount: number) {
  const environments = Array.from({ length: hostCount }, (_, index) =>
    environment(`host-${index}`, 'mine')
  )
  const repos = Array.from({ length: repoCount }, (_, index): Repo => ({
    ...makeRepo(),
    id: `repo-${index}`,
    path: `/repos/project-${index}`,
    displayName: `Project ${Math.floor(index / 2)}`,
    executionHostId: toRuntimeExecutionHostId(environments[index % hostCount]!.id),
    connectionId: `target-${index}`
  }))
  const worktrees = repos.flatMap((repo, index) =>
    Array.from({ length: 3 }, (_, branch) =>
      makeWorktree(`workspace-${index}-${branch}`, `Branch ${branch}`, {
        repoId: repo.id,
        hostId: toRuntimeExecutionHostId(environments[index % hostCount]!.id),
        runtimeOwnerEnvironmentId: environments[index % hostCount]!.id,
        creatorProvenance: { kind: 'paired-device', deviceId: 'mine' }
      })
    )
  )
  const repoMap = new Map(repos.map((repo) => [repo.id, repo]))
  useAppStore.setState({
    repos,
    runtimeEnvironments: [...environments, environment('B')],
    runtimeStatusByEnvironmentId: new Map(),
    sshStateByEnvironment: new Map(),
    worktreesByRepo: Object.fromEntries(
      repos.map((repo) => [repo.id, worktrees.filter((item) => item.repoId === repo.id)])
    )
  })
  for (const owner of [...environments, environment('B')]) {
    publish(owner.id, 1)
    useAppStore.getState().setEnvironmentSshTargetsMetadata(owner.id, [])
  }
  for (let index = 0; index < repos.length; index++) {
    useAppStore
      .getState()
      .setEnvironmentSshConnectionState(
        environments[index % hostCount]!.id,
        `target-${index}`,
        ssh('connected', `target-${index}`)
      )
  }
  return {
    ...sectionArgs(),
    repos,
    repoMap,
    worktrees,
    worktreeMap: new Map(worktrees.map((item) => [item.id, item])),
    visibleReposForRows: repos,
    effectiveCollapsedGroups: new Set(repos.map((repo) => `repo:${repo.id}`))
  }
}
