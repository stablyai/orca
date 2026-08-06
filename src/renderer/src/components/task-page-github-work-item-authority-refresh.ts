import { taskPageGitHubFamilyDirtyKey } from './task-page-github-work-item-mutation-keys'
import {
  clearConfirmedAuthorityForItem,
  deleteConfirmedListSnapshot,
  deleteLastConfirmedClientValue,
  deleteStickyHideEntry,
  getConfirmedListSnapshot,
  getLastConfirmedClientValue,
  getStickyHideEntry,
  getTaskPageGitHubConfirmedAuthorityItemKeys,
  hasPendingTaskPageGitHubOpsForItem,
  listPendingTaskPageGitHubOpsForItem,
  notifyTaskPageGitHubMutationRegistry,
  parseTaskPageGitHubItemKey,
  resolveItemSourceScope,
  updateSoftHiddenItemKey
} from './task-page-github-work-item-mutation-registry'
import { getQuietRevalidateState } from './task-page-github-work-item-quiet-state'
import { MAX_LAG_TRAILS } from './task-page-github-work-item-quiet-adopt'

const AUTHORITY_FAMILIES = ['state', 'autoMerge', 'assignees', 'reviewRequests'] as const

export function clearTaskPageGitHubAuthorityAbsentFromLoadedItems(
  loadedItemKeys: ReadonlySet<string>
): void {
  let changed = false
  for (const itemKey of getTaskPageGitHubConfirmedAuthorityItemKeys()) {
    if (loadedItemKeys.has(itemKey)) {
      continue
    }
    const identity = parseTaskPageGitHubItemKey(itemKey)
    if (!identity) {
      continue
    }
    const { repoId, itemId, repoExecutionHostId } = identity
    if (hasPendingTaskPageGitHubOpsForItem(repoId, itemId, repoExecutionHostId)) {
      continue
    }
    clearConfirmedAuthorityForItem(repoId, itemId, repoExecutionHostId)
    deleteStickyHideEntry(itemKey)
    updateSoftHiddenItemKey(itemKey, false)
    changed = true
  }
  if (changed) {
    notifyTaskPageGitHubMutationRegistry()
  }
}

export function getTaskPageGitHubRevalidatableAuthorityItemKeys(
  queryKey: string
): ReadonlySet<string> {
  const keys = new Set<string>()
  const quiet = getQuietRevalidateState(queryKey)
  for (const itemKey of getTaskPageGitHubConfirmedAuthorityItemKeys()) {
    const identity = parseTaskPageGitHubItemKey(itemKey)
    if (!identity) {
      continue
    }
    const { repoId, itemId, repoExecutionHostId } = identity
    const sourceScope = resolveItemSourceScope(repoId, itemId, repoExecutionHostId)
    const activeFamilies = AUTHORITY_FAMILIES.filter((family) =>
      family === 'assignees' || family === 'reviewRequests'
        ? getConfirmedListSnapshot(sourceScope, repoId, itemId, family) !== undefined
        : getLastConfirmedClientValue(sourceScope, repoId, itemId, family) !== undefined
    )
    if (
      activeFamilies.some(
        (family) =>
          (quiet?.lagSkipAttempts.get(taskPageGitHubFamilyDirtyKey(itemKey, family)) ?? 0) <
          MAX_LAG_TRAILS
      )
    ) {
      keys.add(itemKey)
    }
  }
  return keys
}

export function clearTaskPageGitHubAuthorityThroughGeneration(
  queryKey: string,
  generation: number
): void {
  const quiet = getQuietRevalidateState(queryKey)
  for (const itemKey of getTaskPageGitHubConfirmedAuthorityItemKeys()) {
    const identity = parseTaskPageGitHubItemKey(itemKey)
    if (!identity) {
      continue
    }
    const { repoId, itemId, repoExecutionHostId } = identity
    const sourceScope = resolveItemSourceScope(repoId, itemId, repoExecutionHostId)
    for (const family of AUTHORITY_FAMILIES) {
      const dirtyAt = quiet?.familyDirtyAt.get(taskPageGitHubFamilyDirtyKey(itemKey, family)) ?? 0
      if (dirtyAt > generation) {
        continue
      }
      if (family === 'assignees' || family === 'reviewRequests') {
        deleteConfirmedListSnapshot(sourceScope, repoId, itemId, family)
      } else {
        deleteLastConfirmedClientValue(sourceScope, repoId, itemId, family)
      }
    }
    const hasMembershipAuthority =
      getLastConfirmedClientValue(sourceScope, repoId, itemId, 'state') !== undefined ||
      getConfirmedListSnapshot(sourceScope, repoId, itemId, 'assignees') !== undefined ||
      getConfirmedListSnapshot(sourceScope, repoId, itemId, 'reviewRequests') !== undefined
    const hasPendingMembership = listPendingTaskPageGitHubOpsForItem(
      repoId,
      itemId,
      undefined,
      itemKey
    ).some((op) => op.listOp !== undefined || op.key.opKey === 'state' || op.key.opKey === 'merge')
    if (!hasMembershipAuthority && !hasPendingMembership) {
      if (getStickyHideEntry(itemKey)?.queryKey === queryKey) {
        deleteStickyHideEntry(itemKey)
      }
      if (!hasPendingTaskPageGitHubOpsForItem(repoId, itemId, repoExecutionHostId)) {
        updateSoftHiddenItemKey(itemKey, false)
      }
    }
  }
  notifyTaskPageGitHubMutationRegistry()
}
