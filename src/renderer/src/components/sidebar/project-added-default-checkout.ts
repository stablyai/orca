import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { track } from '@/lib/telemetry'
import type {
  AddRepoDefaultCheckoutHandoffSource,
  EventProps
} from '../../../../shared/telemetry-events'
import type { DetectedWorktreeListResult, Worktree } from '../../../../shared/types'
import { relativePathInsideRoot } from '../../../../shared/cross-platform-path'
import { markOnboardingProjectAdded } from '@/lib/onboarding-project-checklist'
import { finalizeImportedRepoAfterSkip } from './add-repo-skip-finalization'
import type { ExecutionHostId } from '../../../../shared/execution-host'

type DefaultCheckoutHandoffReason = EventProps<'add_repo_default_checkout_handoff'>['reason']

export function getProjectDefaultCheckout(worktrees: readonly Worktree[]): Worktree | null {
  return worktrees.find((worktree) => worktree.isMainWorktree) ?? null
}

function getProjectWorktreesForHost<T extends Worktree>(
  worktrees: readonly T[],
  executionHostId?: ExecutionHostId
): T[] {
  if (!executionHostId) {
    return [...worktrees]
  }
  return worktrees.filter((worktree) => {
    if (worktree.hostId) {
      return worktree.hostId === executionHostId
    }
    if (worktree.runtimeOwnerEnvironmentId) {
      return executionHostId === `runtime:${encodeURIComponent(worktree.runtimeOwnerEnvironmentId)}`
    }
    return executionHostId === 'local'
  })
}

function ownerRefreshOptions(executionHostId?: ExecutionHostId) {
  return {
    requireAuthoritative: true as const,
    ...(executionHostId ? { executionHostId } : {})
  }
}

function getDetectedProjectDefaultCheckout(
  detected: DetectedWorktreeListResult | undefined,
  executionHostId?: ExecutionHostId
): DetectedWorktreeListResult['worktrees'][number] | null {
  if (detected?.authoritative !== true) {
    return null
  }
  return (
    getProjectWorktreesForHost(detected.worktrees, executionHostId).find(
      (worktree) => worktree.isMainWorktree
    ) ?? null
  )
}

function hasDetectedHiddenLinkedExternalWorktrees(
  detected: DetectedWorktreeListResult | undefined,
  executionHostId?: ExecutionHostId
): boolean {
  if (detected?.authoritative !== true) {
    return false
  }
  return getProjectWorktreesForHost(detected.worktrees, executionHostId).some(
    (worktree) =>
      !worktree.isMainWorktree &&
      !worktree.selectedCheckout &&
      !worktree.visible &&
      worktree.ownership !== 'orca-managed' &&
      // Why: a repo whose only externals are agent scratch must not get
      // flipped to repo-wide 'show' by the add handoff (#9388).
      worktree.ownership !== 'agent-scratch'
  )
}

async function revealDetectedHiddenLinkedExternalWorktrees(
  repoId: string,
  executionHostId?: ExecutionHostId
): Promise<DefaultCheckoutHandoffReason | null> {
  const state = useAppStore.getState()
  if (
    !hasDetectedHiddenLinkedExternalWorktrees(
      state.detectedWorktreesByRepo[repoId],
      executionHostId
    )
  ) {
    return null
  }

  // Why: the removed setup step's existing-worktree path made linked external
  // worktrees visible; the automatic handoff must preserve that import result.
  const updated = executionHostId
    ? await state.updateRepo(
        repoId,
        { externalWorktreeVisibility: 'show' },
        { hostId: executionHostId }
      )
    : await state.updateRepo(repoId, { externalWorktreeVisibility: 'show' })
  if (!updated) {
    return 'show_detected_linked_failed'
  }
  const refreshed = await useAppStore
    .getState()
    .fetchWorktrees(repoId, ownerRefreshOptions(executionHostId))
  return refreshed ? null : 'linked_external_refresh_failed'
}

async function findDetectedDefaultCheckout(
  repoId: string,
  executionHostId?: ExecutionHostId
): Promise<{
  worktree: Worktree | null
  reason: DefaultCheckoutHandoffReason
}> {
  const state = useAppStore.getState()
  const detected = state.detectedWorktreesByRepo[repoId]
  const detectedDefaultCheckout = getDetectedProjectDefaultCheckout(detected, executionHostId)
  if (!detectedDefaultCheckout) {
    return {
      worktree: null,
      reason:
        detected?.authoritative === true ? 'no_default_checkout' : 'no_authoritative_detection'
    }
  }
  if (!detectedDefaultCheckout.visible) {
    // Why: a freshly cloned primary checkout can be detected as a hidden
    // external worktree; adding a project should make that checkout usable.
    const updated = executionHostId
      ? await state.updateRepo(
          repoId,
          { externalWorktreeVisibility: 'show' },
          { hostId: executionHostId }
        )
      : await state.updateRepo(repoId, { externalWorktreeVisibility: 'show' })
    if (!updated) {
      return { worktree: null, reason: 'show_detected_default_failed' }
    }
  }
  const refreshed = await useAppStore
    .getState()
    .fetchWorktrees(repoId, ownerRefreshOptions(executionHostId))
  if (!refreshed) {
    return { worktree: null, reason: 'authoritative_refresh_failed' }
  }
  const worktree = getProjectDefaultCheckout(
    getProjectWorktreesForHost(
      useAppStore.getState().worktreesByRepo[repoId] ?? [],
      executionHostId
    )
  )
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
  let defaultCheckout = getProjectDefaultCheckout(
    getProjectWorktreesForHost(
      useAppStore.getState().worktreesByRepo[repoId] ?? [],
      executionHostId
    )
  )
  let reason: DefaultCheckoutHandoffReason = 'loaded_default_checkout'
  if (!defaultCheckout) {
    const detectedDefaultCheckout = await findDetectedDefaultCheckout(repoId, executionHostId)
    defaultCheckout = detectedDefaultCheckout.worktree
    reason = detectedDefaultCheckout.reason
  }

  if (defaultCheckout) {
    const revealLinkedFailureReason = await revealDetectedHiddenLinkedExternalWorktrees(
      repoId,
      executionHostId
    )
    if (revealLinkedFailureReason) {
      track('add_repo_default_checkout_handoff', {
        source,
        result: 'revealed_project',
        reason: revealLinkedFailureReason
      })
      finalizeImportedRepoAfterSkip(useAppStore.getState(), repoId)
      return
    }
    // Why: the onboarding handoff should land on the default checkout even
    // when the user normally hides default-branch workspaces in the sidebar.
    const state = useAppStore.getState()
    if (state.hideDefaultBranchWorkspace) {
      setHideDefaultBranchWorkspace(false)
    }
    track('add_repo_default_checkout_handoff', {
      source,
      result: 'opened_default_checkout',
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
    return
  }

  track('add_repo_default_checkout_handoff', {
    source,
    result: 'revealed_project',
    reason
  })
  finalizeImportedRepoAfterSkip(useAppStore.getState(), repoId)
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
