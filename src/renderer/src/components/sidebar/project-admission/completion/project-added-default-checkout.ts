import { useAppStore } from '@/store/index'
import { activateAndRevealWorktree } from '@/lib/workspace/activation/worktree-activation'
import { track } from '@/diagnostics/telemetry/telemetry'
import type { AddRepoDefaultCheckoutHandoffSource } from '../../../../../../shared/telemetry/schemas/telemetry-property-schemas'
import type { EventProps } from '../../../../../../shared/telemetry/telemetry-event-classification'
import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  splitPathSegments,
  relativePathInsideRoot
} from '../../../../../../shared/file-access/cross-platform-path'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import { repoMatchesHostIdentity } from '@/store/repos/repo-host-identity'
import { selectExecutionHostDisplayLabel } from '@/runtime/hosts/display/execution-host-display-label'
import { worktreeMatchesHost } from '@/store/slices/worktrees/listing/worktree-host-ownership'
import {
  getHiddenExternalWorktrees,
  mergeExternalWorktreeInboxPaths
} from '../../../../../../shared/worktree/visibility/external-worktree-inbox'
import { markOnboardingProjectAdded } from '@/components/onboarding/onboarding-project-checklist'
import { finalizeImportedRepoAfterSkip } from './add-repo-skip-finalization'
import { showSelectedCheckoutFailure } from './selected-checkout-failure-toast'
import { captureCheckoutHandoffIntent, type CheckoutHandoffIntent } from './checkout-handoff-intent'
import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import {
  selectDetectedWorktreesByRepo,
  selectWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'

type DefaultCheckoutHandoffReason = EventProps<'add_repo_default_checkout_handoff'>['reason']

function findProjectRepo(repoId: string, executionHostId?: ExecutionHostId): Repo | null {
  const matches = useAppStore
    .getState()
    .repos.filter((repo) =>
      executionHostId ? repoMatchesHostIdentity(repo, repoId, executionHostId) : repo.id === repoId
    )
  return matches.length === 1 ? matches[0] : null
}

function getProjectInitialCheckout<T extends Worktree>(
  worktrees: readonly T[],
  selectedPath: string
): T | null {
  if (
    splitPathSegments(selectedPath, selectedPath).some(
      (segment) => segment === '.' || segment === '..'
    )
  ) {
    return null
  }
  let containing: T | null = null
  for (const worktree of worktrees) {
    if (
      relativePathInsideRoot(worktree.path, selectedPath) !== null &&
      (!containing || relativePathInsideRoot(containing.path, worktree.path) !== null)
    ) {
      containing = worktree
    }
  }
  return containing
}

async function resolveInitialCheckout(
  repo: Repo,
  selectedPath: string,
  executionHostId: ExecutionHostId
): Promise<{ worktree: Worktree | null; reason: DefaultCheckoutHandoffReason }> {
  const refreshOptions = { executionHostId, requireAuthoritative: true, forceFresh: true }
  const refreshed = await useAppStore.getState().fetchWorktrees(repo.id, refreshOptions)
  if (!refreshed) {
    return { worktree: null, reason: 'authoritative_refresh_failed' }
  }
  if (!findProjectRepo(repo.id, executionHostId)) {
    return { worktree: null, reason: 'no_default_checkout' }
  }
  const detected = selectDetectedWorktreesByRepo(useAppStore.getState())[repo.id]
  if (detected?.authoritative !== true) {
    return { worktree: null, reason: 'no_authoritative_detection' }
  }
  const detectedForHost = {
    ...detected,
    worktrees: detected.worktrees.filter((worktree) =>
      worktreeMatchesHost(worktree, executionHostId)
    )
  }
  const target = getProjectInitialCheckout(detectedForHost.worktrees, selectedPath)
  if (!target) {
    return { worktree: null, reason: 'no_default_checkout' }
  }
  const dismissPrompt =
    getHiddenExternalWorktrees(detectedForHost).length > 0 &&
    repo.externalWorktreeVisibilityPromptDismissedAt === undefined
  if (!target.visible || dismissPrompt) {
    const updated = await useAppStore.getState().updateRepo(
      repo.id,
      (latestRepo) => ({
        ...(!target.visible
          ? {
              importedExternalWorktreePaths: mergeExternalWorktreeInboxPaths(
                latestRepo.importedExternalWorktreePaths,
                [target.path]
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
      { hostId: executionHostId }
    )
    if (!updated) {
      return { worktree: null, reason: 'show_detected_default_failed' }
    }
    if (!(await useAppStore.getState().fetchWorktrees(repo.id, refreshOptions))) {
      return { worktree: null, reason: 'authoritative_refresh_failed' }
    }
  }
  const worktree =
    findProjectRepo(repo.id, executionHostId) &&
    (selectWorktreesByRepo(useAppStore.getState())[repo.id] ?? []).find(
      (candidate) => candidate.id === target.id && worktreeMatchesHost(candidate, executionHostId)
    )
  return {
    worktree: worktree || null,
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

/** Runs fn under the caller's intent, or one captured now and released when fn settles. */
async function withIntent(
  given: CheckoutHandoffIntent | undefined,
  fn: (intent: CheckoutHandoffIntent) => Promise<void>
): Promise<void> {
  const intent = given ?? captureCheckoutHandoffIntent()
  try {
    await fn(intent)
  } finally {
    if (!given) {
      intent.dispose()
    }
  }
}

export function openProjectDefaultCheckout({
  repoId,
  source,
  selectedPath,
  executionHostId,
  intent
}: {
  repoId: string
  source: AddRepoDefaultCheckoutHandoffSource
  selectedPath?: string
  executionHostId?: ExecutionHostId
  /** The user's add; omitted, the foreground at this call is what the handoff may change. */
  intent?: CheckoutHandoffIntent
}): Promise<void> {
  return withIntent(intent, async (reveal) => {
    const repo = findProjectRepo(repoId, executionHostId)
    const ownerHostId = executionHostId ?? (repo ? getRepoExecutionHostId(repo) : undefined)
    const { worktree: defaultCheckout, reason } =
      repo && ownerHostId
        ? await resolveInitialCheckout(repo, selectedPath ?? repo.path, ownerHostId)
        : { worktree: null, reason: 'no_default_checkout' as const }

    if (!reveal.canReveal()) {
      return
    }
    if (defaultCheckout) {
      track('add_repo_default_checkout_handoff', {
        source,
        result: defaultCheckout.isMainWorktree
          ? 'opened_default_checkout'
          : 'opened_selected_checkout',
        reason
      })
      const initialCwd = resolveInitialCwdForDefaultCheckout(defaultCheckout, selectedPath)
      // Why user-open: adding the project is the user's open, so its first tab follows their Chat UI/Terminal choice.
      activateAndRevealWorktree(defaultCheckout.id, {
        navigationIntent: 'user-open',
        ...(initialCwd ? { initialCwd } : {}),
        ...(ownerHostId ? { executionHostId: ownerHostId } : {})
      })
      return
    }

    track('add_repo_default_checkout_handoff', {
      source,
      result: 'revealed_project',
      reason
    })
    // The owner can be removed while listing runs: a vanished one is neither revealed nor retried.
    if (!ownerHostId || !findProjectRepo(repoId, ownerHostId)) {
      showSelectedCheckoutFailure(repoId, { kind: 'owner_unavailable' })
      return
    }
    finalizeImportedRepoAfterSkip(useAppStore.getState(), repoId)
    const retry = () => {
      void openProjectDefaultCheckout({
        repoId,
        source,
        selectedPath,
        executionHostId: ownerHostId
      })
    }
    showSelectedCheckoutFailure(
      repoId,
      reason === 'show_detected_default_failed'
        ? { kind: 'save_failed', retry }
        : reason === 'no_default_checkout' || reason === 'refreshed_default_missing'
          ? { kind: 'missing', retry }
          : {
              kind: 'refresh_failed',
              hostLabel: selectExecutionHostDisplayLabel(useAppStore.getState(), ownerHostId),
              retry
            }
    )
  })
}

export function finishProjectAddWithDefaultCheckout({
  repoId,
  source,
  selectedPath,
  closeModal,
  executionHostId,
  intent
}: {
  repoId: string
  source: AddRepoDefaultCheckoutHandoffSource
  selectedPath?: string
  closeModal: () => void
  executionHostId?: ExecutionHostId
  /** Captured when the user confirmed, before the add's own work; see openProjectDefaultCheckout. */
  intent?: CheckoutHandoffIntent
}): Promise<void> {
  return withIntent(intent, async (reveal) => {
    await markOnboardingProjectAdded('addedRepo')
    if (!reveal.closeOwnModal(closeModal)) {
      return
    }
    await openProjectDefaultCheckout({
      repoId,
      source,
      selectedPath,
      executionHostId,
      intent: reveal
    })
  })
}
