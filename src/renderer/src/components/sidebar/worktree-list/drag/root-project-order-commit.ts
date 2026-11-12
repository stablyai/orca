import { getRepoExecutionHostId } from '../../../../../../shared/execution-host'
import { PROJECT_ROOT_ORDER_RUNTIME_CAPABILITY } from '../../../../../../shared/project-group-order-capability'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/rpc/compatibility/runtime-capability-proof'
import { ipcOrRuntimeTargetForHostId } from '@/runtime/rpc/targets/runtime-client-target'
import '@/store/project-groups/project-group-owner-routing'
import type { RepoSlice } from '@/store/repos/repo-state'
import { getIndexedReposById } from '@/store/repos/repository-catalog-index'
import { getRootProjectOrderUpdatesForSidebarDrop } from './root-project-header-drop'

export async function saveRootProjectOrderForSidebarDrop(args: {
  state: Pick<RepoSlice, 'repos' | 'projectGroups' | 'updateRepo' | 'updateProjectGroups'>
  visibleKeys: readonly string[]
  draggedKey: string
  dropIndex: number
  hostId?: string
  onCommit: () => void
}): Promise<boolean> {
  const { state } = args
  const updates = getRootProjectOrderUpdatesForSidebarDrop({
    ...args,
    repos: state.repos,
    projectGroups: state.projectGroups
  })
  if (updates.length === 0) {
    return true
  }
  const groupCopiesById = Map.groupBy(state.projectGroups, (group) => group.id)
  const groupUpdates = updates.flatMap((update) => {
    if (update.entry.kind !== 'group') {
      return []
    }
    const groupId = update.entry.group.id
    return (groupCopiesById.get(groupId) ?? []).map((group) => ({ ...update, group }))
  })
  const repoUpdates = updates.flatMap((update) => {
    if (update.entry.kind !== 'repo' || update.rootProjectOrder === undefined) {
      return []
    }
    const repoId = update.entry.repo.id
    const order = update.rootProjectOrder
    return getIndexedReposById(state.repos, repoId)
      .filter((repo) => !repo.projectGroupId || !groupCopiesById.has(repo.projectGroupId))
      .map((repo) => ({ repo, order }))
  })
  const targets = groupUpdates.flatMap((update) => {
    const target = ipcOrRuntimeTargetForHostId(getRepoExecutionHostId(update.group))
    return update.rootProjectOrder !== undefined && target?.kind === 'environment'
      ? [target.environmentId]
      : []
  })
  targets.push(
    ...repoUpdates.flatMap(({ repo }) => {
      const target = ipcOrRuntimeTargetForHostId(getRepoExecutionHostId(repo))
      return repo.projectGroupOrder === undefined && target?.kind === 'environment'
        ? [target.environmentId]
        : []
    })
  )
  // Older servers cannot restore absent repo ranks or persist root group ranks.
  const supported = await Promise.all(
    [...new Set(targets)].map((environmentId) =>
      runtimeEnvironmentSupportsCapability(environmentId, PROJECT_ROOT_ORDER_RUNTIME_CAPABILITY)
    )
  )
  if (supported.includes(false)) {
    return false
  }
  args.onCommit()
  const mutations: { save: () => Promise<boolean>; restore: () => Promise<boolean> }[] = []
  if (groupUpdates.length > 0) {
    mutations.push({
      save: () =>
        state.updateProjectGroups(
          groupUpdates.map(({ group, rootProjectOrder, tabOrder }) => ({
            groupId: group.id,
            hostId: getRepoExecutionHostId(group),
            updates: {
              ...(rootProjectOrder !== undefined ? { rootProjectOrder } : {}),
              ...(tabOrder !== undefined ? { tabOrder } : {})
            }
          }))
        ),
      restore: () =>
        Promise.all(
          groupUpdates.map(({ group, rootProjectOrder, tabOrder }) =>
            state
              .updateProjectGroups([
                {
                  groupId: group.id,
                  hostId: getRepoExecutionHostId(group),
                  updates: {
                    ...(rootProjectOrder !== undefined
                      ? { rootProjectOrder: group.rootProjectOrder ?? null }
                      : {}),
                    ...(tabOrder !== undefined ? { tabOrder: group.tabOrder } : {})
                  }
                }
              ])
              .catch(() => false)
          )
        ).then((results) => results.every(Boolean))
    })
  }
  for (const { repo, order } of repoUpdates) {
    const hostId = getRepoExecutionHostId(repo)
    mutations.push({
      save: () => state.updateRepo(repo.id, { projectGroupOrder: order }, { hostId }),
      restore: () =>
        state.updateRepo(repo.id, { projectGroupOrder: repo.projectGroupOrder ?? null }, { hostId })
    })
  }
  const saved = await Promise.all(mutations.map((mutation) => mutation.save().catch(() => false)))
  if (saved.every(Boolean)) {
    return true
  }
  // A failed owner must not leave successful copies reordered; restore every attempted write.
  await Promise.all(mutations.map((mutation) => mutation.restore().catch(() => false)))
  return false
}

type RootProjectOrderState = Parameters<typeof saveRootProjectOrderForSidebarDrop>[0]['state']
const rootProjectOrderCommitChains = new WeakMap<() => RootProjectOrderState, Promise<void>>()

export function enqueueRootProjectOrderForSidebarDrop(
  args: Omit<Parameters<typeof saveRootProjectOrderForSidebarDrop>[0], 'state'> & {
    getState: () => RootProjectOrderState
  }
): Promise<boolean> {
  const previous = rootProjectOrderCommitChains.get(args.getState) ?? Promise.resolve()
  const saved = previous.then(() =>
    saveRootProjectOrderForSidebarDrop({ ...args, state: args.getState() })
  )
  rootProjectOrderCommitChains.set(
    args.getState,
    saved.then(
      () => {},
      () => {}
    )
  )
  return saved
}
