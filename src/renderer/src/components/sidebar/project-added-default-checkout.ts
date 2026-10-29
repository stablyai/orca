import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { track } from '@/lib/telemetry'
import type {
  AddRepoDefaultCheckoutHandoffSource,
  EventProps
} from '../../../../shared/telemetry-events'
import type { Repo } from '../../../../shared/repo-types'
import type { DetectedWorktree, Worktree } from '../../../../shared/worktree/types'
import { areRuntimePathsEqual } from '../../../../shared/worktree/ownership'
import { relativePathInsideRoot } from '../../../../shared/cross-platform-path'
import { mergeExternalWorktreeInboxPaths } from '../../../../shared/external-worktree-inbox'
import { markOnboardingProjectAdded } from '@/lib/onboarding-project-checklist'
import { finalizeImportedRepoAfterSkip } from './add-repo-skip-finalization'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import {
  selectDetectedWorktreesByRepo,
  selectWorktreesByRepo
} from '@/store/workspace-record-selectors'

type DefaultCheckoutHandoffReason = EventProps<'add_repo_default_checkout_handoff'>['reason']

// The first anchor any checkout contains wins, and its deepest container beats a parent checkout.
export function getProjectDefaultCheckout<T extends Worktree>(
  worktrees: readonly T[],
  anchorPaths: readonly (string | undefined)[] = []
): T | null {
  for (const anchorPath of anchorPaths) {
    if (!anchorPath) {
      continue
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
  return worktrees.find((worktree) => worktree.isMainWorktree) ?? null
}

function getProjectWorktreesForHost<T extends Worktree>(
  worktrees: readonly T[],
  executionHostId?: ExecutionHostId
): T[] {
  if (!executionHostId) {
    return [...worktrees]
  }
  const parsedHost = parseExecutionHostId(executionHostId)
  return worktrees.filter((worktree) => {
    if (parsedHost?.kind === 'runtime') {
      if (worktree.runtimeOwnerEnvironmentId) {
        return worktree.runtimeOwnerEnvironmentId === parsedHost.environmentId
      }
      // Colliding repo IDs may carry only hostId, so match runtime-qualified hosts too.
      return worktree.hostId === executionHostId
    }
    if (worktree.runtimeOwnerEnvironmentId) {
      return false
    }
    if (worktree.hostId) {
      return worktree.hostId === executionHostId
    }
    return executionHostId === 'local'
  })
}

// Match the owner row only; an ambiguous bare ID has no owner, never the focused host.
function findProjectRepo(repoId: string, executionHostId?: ExecutionHostId): Repo | null {
  const owners = useAppStore
    .getState()
    .repos.filter(
      (repo) =>
        repo.id === repoId && (!executionHostId || getRepoExecutionHostId(repo) === executionHostId)
    )
  return owners.length === 1 ? owners[0] : null
}

function findLoadedDefaultCheckout(
  repoId: string,
  anchorPaths: readonly (string | undefined)[],
  executionHostId?: ExecutionHostId
): Worktree | null {
  return getProjectDefaultCheckout(
    getProjectWorktreesForHost(
      selectWorktreesByRepo(useAppStore.getState())[repoId] ?? [],
      executionHostId
    ),
    anchorPaths
  )
}

// Detection includes hidden checkouts, so a picked hidden linked checkout wins over the visible primary.
function findDetectedDefaultCheckout(
  repoId: string,
  anchorPaths: readonly (string | undefined)[],
  executionHostId?: ExecutionHostId
): DetectedWorktree | null {
  const detected = selectDetectedWorktreesByRepo(useAppStore.getState())[repoId]
  if (detected?.authoritative !== true) {
    return null
  }
  return getProjectDefaultCheckout(
    getProjectWorktreesForHost(detected.worktrees, executionHostId),
    anchorPaths
  )
}

async function refreshDefaultCheckout(
  repoId: string,
  anchorPaths: readonly (string | undefined)[],
  executionHostId?: ExecutionHostId,
  refreshHostId?: ExecutionHostId
): Promise<{
  worktree: Worktree | null
  reason: DefaultCheckoutHandoffReason
}> {
  const refreshed = await useAppStore.getState().fetchWorktrees(repoId, {
    requireAuthoritative: true,
    ...(refreshHostId ? { executionHostId: refreshHostId } : {})
  })
  if (!refreshed) {
    return { worktree: null, reason: 'authoritative_refresh_failed' }
  }
  const worktree = findLoadedDefaultCheckout(repoId, anchorPaths, executionHostId)
  return {
    worktree,
    reason: worktree ? 'detected_default_checkout' : 'refreshed_default_missing'
  }
}

async function resolveProjectCheckout(
  repoId: string,
  selectedPath: string | undefined,
  executionHostId?: ExecutionHostId
): Promise<{
  worktree: Worktree | null
  reason: DefaultCheckoutHandoffReason
}> {
  const repo = findProjectRepo(repoId, executionHostId)
  // A linked checkout picked for an already-registered repo resolves to that repo's row, so the picked path leads.
  const anchorPaths = [selectedPath, repo?.path]
  const loaded = findLoadedDefaultCheckout(repoId, anchorPaths, executionHostId)
  const detected = findDetectedDefaultCheckout(repoId, anchorPaths, executionHostId)
  const detectedIsLoaded =
    !!loaded && !!detected && areRuntimePathsEqual(loaded.path, detected.path)
  if (repo && detected && !detected.visible && !detectedIsLoaded) {
    // Import only the picked checkout into the owner row; its siblings stay behind the hidden-worktrees notice.
    // Merge onto the row as of the queued write so an overlapping import is not dropped.
    const ownerHostId = getRepoExecutionHostId(repo)
    const updated = await useAppStore.getState().updateRepo(
      repoId,
      (latestRepo) => ({
        importedExternalWorktreePaths: mergeExternalWorktreeInboxPaths(
          latestRepo.importedExternalWorktreePaths,
          [detected.path]
        )
      }),
      { hostId: ownerHostId }
    )
    if (!updated) {
      return { worktree: null, reason: 'show_detected_default_failed' }
    }
    return refreshDefaultCheckout(repoId, anchorPaths, executionHostId, ownerHostId)
  }
  // A hidden pick without an owner row has no host row to import into, so keep what is loaded.
  if (loaded && !(detected?.visible && !detectedIsLoaded)) {
    return { worktree: loaded, reason: 'loaded_default_checkout' }
  }
  return refreshDefaultCheckout(repoId, anchorPaths, executionHostId, executionHostId)
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
  const { worktree: defaultCheckout, reason } = await resolveProjectCheckout(
    repoId,
    selectedPath,
    executionHostId
  )

  if (!defaultCheckout) {
    track('add_repo_default_checkout_handoff', {
      source,
      result: 'revealed_project',
      reason
    })
    finalizeImportedRepoAfterSkip(useAppStore.getState(), repoId)
    return
  }

  // Onboarding must reveal its default checkout even when the normal sidebar preference hides it.
  if (defaultCheckout.isMainWorktree && useAppStore.getState().hideDefaultBranchWorkspace) {
    setHideDefaultBranchWorkspace(false)
  }
  track('add_repo_default_checkout_handoff', {
    source,
    result: defaultCheckout.isMainWorktree ? 'opened_default_checkout' : 'opened_selected_checkout',
    reason
  })
  const initialCwd = resolveInitialCwdForDefaultCheckout(defaultCheckout, selectedPath)
  if (initialCwd || executionHostId) {
    activateAndRevealWorktree(defaultCheckout.id, {
      ...(initialCwd ? { initialCwd } : {}),
      ...(executionHostId ? { executionHostId } : {})
    })
  } else {
    activateAndRevealWorktree(defaultCheckout.id)
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
