import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { track } from '@/lib/telemetry'
import type {
  AddRepoDefaultCheckoutHandoffSource,
  EventProps
} from '../../../../shared/telemetry-events'
import type { DetectedWorktreeListResult, Worktree } from '../../../../shared/worktree/types'
import { relativePathInsideRoot } from '../../../../shared/cross-platform-path'
import { markOnboardingProjectAdded } from '@/lib/onboarding-project-checklist'
import { finalizeImportedRepoAfterSkip } from './add-repo-skip-finalization'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import {
  selectDetectedWorktreesByRepo,
  selectWorktreesByRepo
} from '@/store/workspace-record-selectors'

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
      // Agent scratch alone must not enable repo-wide external visibility.
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
      selectDetectedWorktreesByRepo(state)[repoId],
      executionHostId
    )
  ) {
    return null
  }

  // Preserve external-worktree visibility formerly set by the explicit import step.
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
  const detected = selectDetectedWorktreesByRepo(state)[repoId]
  const detectedDefaultCheckout = getDetectedProjectDefaultCheckout(detected, executionHostId)
  if (!detectedDefaultCheckout) {
    return {
      worktree: null,
      reason:
        detected?.authoritative === true ? 'no_default_checkout' : 'no_authoritative_detection'
    }
  }
  if (!detectedDefaultCheckout.visible) {
    // Freshly cloned primary checkouts may be hidden externals; expose them when adding the project.
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
      selectWorktreesByRepo(useAppStore.getState())[repoId] ?? [],
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
      selectWorktreesByRepo(useAppStore.getState())[repoId] ?? [],
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
    // Onboarding must reveal its default checkout even when the normal sidebar preference hides it.
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
    activateAndRevealWorktree(defaultCheckout.id, {
      navigationIntent: 'user-open',
      ...(initialCwd ? { initialCwd } : {}),
      ...(executionHostId ? { executionHostId } : {})
    })
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
