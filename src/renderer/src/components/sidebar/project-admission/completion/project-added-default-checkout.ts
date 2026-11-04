import { useAppStore } from '@/store/index'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { track } from '@/lib/telemetry'
import type {
  AddRepoDefaultCheckoutHandoffSource,
  EventProps
} from '../../../../../../shared/telemetry-events'
import type { DetectedWorktreeListResult, Worktree } from '../../../../../../shared/worktree/types'
import { relativePathInsideRoot } from '../../../../../../shared/cross-platform-path'
import { markOnboardingProjectAdded } from '@/lib/onboarding-project-checklist'
import { finalizeImportedRepoAfterSkip } from './add-repo-skip-finalization'
import { parseExecutionHostId, type ExecutionHostId } from '../../../../../../shared/execution-host'
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
  const worktrees = getProjectWorktreesForHost(detected.worktrees, executionHostId)
  // Adding a project never reveals discovered worktrees: a picked linked worktree opens itself.
  return (
    worktrees.find((worktree) => worktree.isMainWorktree && worktree.visible) ??
    worktrees.find((worktree) => worktree.selectedCheckout) ??
    null
  )
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
  const refreshed = await useAppStore
    .getState()
    .fetchWorktrees(repoId, ownerRefreshOptions(executionHostId))
  if (!refreshed) {
    return { worktree: null, reason: 'authoritative_refresh_failed' }
  }
  const worktree =
    getProjectWorktreesForHost(
      selectWorktreesByRepo(useAppStore.getState())[repoId] ?? [],
      executionHostId
    ).find((candidate) => candidate.id === detectedDefaultCheckout.id) ?? null
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
