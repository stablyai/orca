import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { track } from '@/lib/telemetry'
import type {
  AddRepoDefaultCheckoutHandoffSource,
  EventProps
} from '../../../../shared/telemetry-events'
import type { Worktree } from '../../../../shared/worktree/types'
import { relativePathInsideRoot } from '../../../../shared/cross-platform-path'
import {
  getHiddenExternalWorktrees,
  hasCompletedInitialExternalWorktreeImportPrompt,
  mergeExternalWorktreeInboxPaths
} from '../../../../shared/external-worktree-inbox'
import { markOnboardingProjectAdded } from '@/lib/onboarding-project-checklist'
import { finalizeImportedRepoAfterSkip } from './add-repo-skip-finalization'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { repoMatchesHostIdentity } from '@/store/slices/repo-host-identity'
import { worktreeMatchesHost } from '@/store/slices/worktrees/listing/worktree-host-ownership'
import type { Repo } from '../../../../shared/repo-types'
import {
  selectDetectedWorktreesByRepo,
  selectWorktreesByRepo
} from '@/store/workspace-record-selectors'

type DefaultCheckoutHandoffReason = EventProps<'add_repo_default_checkout_handoff'>['reason']

function getProjectInitialCheckout<T extends Worktree>(
  worktrees: readonly T[],
  anchorPaths: readonly (string | undefined)[]
): T | null {
  for (const anchorPath of anchorPaths) {
    if (!anchorPath) {
      continue
    }
    if (anchorPath.split(/[\\/]/).some((segment) => segment === '.' || segment === '..')) {
      return null
    }
    let containing: T | null = null
    for (const worktree of worktrees) {
      if (
        relativePathInsideRoot(worktree.path, anchorPath) !== null &&
        (!containing || relativePathInsideRoot(containing.path, worktree.path) !== null)
      ) {
        containing = worktree
      }
    }
    if (containing) {
      return containing
    }
  }
  return anchorPaths.some(Boolean)
    ? null
    : (worktrees.find((worktree) => worktree.isMainWorktree) ?? null)
}

function getProjectWorktreesForHost<T extends Worktree>(
  worktrees: readonly T[],
  executionHostId?: ExecutionHostId
): T[] {
  if (!executionHostId) {
    return [...worktrees]
  }
  return worktrees.filter((worktree) => worktreeMatchesHost(worktree, executionHostId))
}

function getLoadedProjectWorktrees(repoId: string, executionHostId?: ExecutionHostId): Worktree[] {
  return getProjectWorktreesForHost(
    selectWorktreesByRepo(useAppStore.getState())[repoId] ?? [],
    executionHostId
  )
}

function ownerRefreshOptions(executionHostId?: ExecutionHostId) {
  return {
    requireAuthoritative: true as const,
    ...(executionHostId ? { executionHostId } : {})
  }
}

// Never falls back to the focused host: an ID shared across hosts needs the captured owner.
function findProjectRepo(repoId: string, executionHostId?: ExecutionHostId): Repo | null {
  const matches = useAppStore
    .getState()
    .repos.filter((repo) =>
      executionHostId ? repoMatchesHostIdentity(repo, repoId, executionHostId) : repo.id === repoId
    )
  return matches.length === 1 ? matches[0] : null
}

async function resolveInitialCheckout(
  repoId: string,
  anchorPaths: readonly (string | undefined)[],
  executionHostId?: ExecutionHostId
): Promise<{
  worktree: Worktree | null
  reason: DefaultCheckoutHandoffReason
}> {
  const repo = findProjectRepo(repoId, executionHostId)
  if (!repo && useAppStore.getState().repos.some((candidate) => candidate.id === repoId)) {
    return { worktree: null, reason: 'no_default_checkout' }
  }
  let detected = selectDetectedWorktreesByRepo(useAppStore.getState())[repoId]
  if (
    anchorPaths[0] &&
    (detected?.authoritative !== true ||
      getProjectWorktreesForHost(detected.worktrees, executionHostId).length === 0)
  ) {
    const refreshed = await useAppStore
      .getState()
      .fetchWorktrees(repoId, ownerRefreshOptions(executionHostId))
    detected = selectDetectedWorktreesByRepo(useAppStore.getState())[repoId]
    if (!refreshed || detected?.authoritative !== true) {
      return { worktree: null, reason: 'no_authoritative_detection' }
    }
  }
  const loaded = getLoadedProjectWorktrees(repoId, executionHostId)
  const detectedForHost = detected && {
    ...detected,
    worktrees: getProjectWorktreesForHost(detected.worktrees, executionHostId)
  }
  // Detection includes hidden checkouts, so a picked hidden checkout wins over the visible primary.
  const target =
    detectedForHost?.authoritative === true
      ? getProjectInitialCheckout(detectedForHost.worktrees, anchorPaths)
      : null
  const loadedTarget = target
    ? loaded.find((worktree) => worktree.id === target.id)
    : detectedForHost?.authoritative === true
      ? null
      : getProjectInitialCheckout(loaded, anchorPaths)
  const importPath = target && !target.visible && !loadedTarget ? target.path : undefined
  const dismissPrompt =
    repo !== null &&
    (target !== null || loadedTarget !== null) &&
    !hasCompletedInitialExternalWorktreeImportPrompt(repo) &&
    getHiddenExternalWorktrees(detectedForHost).length > 0
  if (importPath || dismissPrompt) {
    // Import only the opened checkout and route hidden siblings to the existing compact hint.
    const updated =
      repo !== null &&
      (await useAppStore.getState().updateRepo(
        repoId,
        (latestRepo) => ({
          ...(importPath
            ? {
                importedExternalWorktreePaths: mergeExternalWorktreeInboxPaths(
                  latestRepo.importedExternalWorktreePaths,
                  [importPath]
                )
              }
            : {}),
          ...(dismissPrompt
            ? {
                externalWorktreeVisibilityPromptDismissedAt:
                  latestRepo.externalWorktreeVisibilityPromptDismissedAt ?? Date.now()
              }
            : {})
        }),
        { hostId: getRepoExecutionHostId(repo) }
      ))
    if (importPath && !updated) {
      return { worktree: null, reason: 'show_detected_default_failed' }
    }
  }
  if (loadedTarget) {
    return { worktree: loadedTarget, reason: 'loaded_default_checkout' }
  }
  if (!target) {
    return {
      worktree: null,
      reason:
        detected?.authoritative === true ? 'no_default_checkout' : 'no_authoritative_detection'
    }
  }
  const refreshed = await useAppStore
    .getState()
    .fetchWorktrees(repoId, ownerRefreshOptions(executionHostId))
  if (!refreshed) {
    return { worktree: null, reason: 'authoritative_refresh_failed' }
  }
  const worktree =
    getLoadedProjectWorktrees(repoId, executionHostId).find(
      (candidate) => candidate.id === target.id
    ) ?? null
  return {
    worktree,
    reason: worktree ? 'detected_default_checkout' : 'refreshed_default_missing'
  }
}

function resolveInitialCwdForDefaultCheckout(
  defaultCheckout: Worktree,
  selectedPath: string | undefined
): string | undefined {
  if (!selectedPath) {
    return undefined
  }
  const relativePath = relativePathInsideRoot(defaultCheckout.path, selectedPath)
  return relativePath && relativePath.length > 0 ? selectedPath : undefined
}

export async function openProjectDefaultCheckout({
  repoId,
  source,
  selectedPath,
  setHideDefaultBranchWorkspace,
  executionHostId
}: {
  repoId: string
  source: AddRepoDefaultCheckoutHandoffSource
  selectedPath?: string
  setHideDefaultBranchWorkspace: (value: boolean) => void
  executionHostId?: ExecutionHostId
}): Promise<void> {
  // A project registered at a linked checkout reopens that checkout rather than the hidden primary.
  const repo = findProjectRepo(repoId, executionHostId)
  const ownerHostId = executionHostId ?? (repo ? getRepoExecutionHostId(repo) : undefined)
  const { worktree: checkout, reason } = await resolveInitialCheckout(
    repoId,
    selectedPath ? [selectedPath] : [repo?.path],
    ownerHostId
  )

  if (!checkout) {
    track('add_repo_default_checkout_handoff', {
      source,
      result: 'revealed_project',
      reason
    })
    finalizeImportedRepoAfterSkip(useAppStore.getState(), repoId)
    return
  }

  // Onboarding must reveal its default checkout even when the normal sidebar preference hides it.
  if (checkout.isMainWorktree && useAppStore.getState().hideDefaultBranchWorkspace) {
    setHideDefaultBranchWorkspace(false)
  }
  track('add_repo_default_checkout_handoff', {
    source,
    result: checkout.isMainWorktree ? 'opened_default_checkout' : 'opened_selected_checkout',
    reason
  })
  const initialCwd = resolveInitialCwdForDefaultCheckout(checkout, selectedPath)
  if (initialCwd || ownerHostId) {
    activateAndRevealWorktree(checkout.id, {
      ...(initialCwd ? { initialCwd } : {}),
      ...(ownerHostId ? { executionHostId: ownerHostId } : {})
    })
  } else {
    activateAndRevealWorktree(checkout.id)
  }
}

export async function finishProjectAddWithDefaultCheckout({
  repoId,
  source,
  selectedPath,
  closeModal,
  setHideDefaultBranchWorkspace,
  executionHostId
}: {
  repoId: string
  source: AddRepoDefaultCheckoutHandoffSource
  selectedPath?: string
  closeModal: () => void
  setHideDefaultBranchWorkspace: (value: boolean) => void
  executionHostId?: ExecutionHostId
}): Promise<void> {
  await markOnboardingProjectAdded('addedRepo')
  closeModal()
  await openProjectDefaultCheckout({
    repoId,
    source,
    selectedPath,
    executionHostId,
    setHideDefaultBranchWorkspace
  })
}
