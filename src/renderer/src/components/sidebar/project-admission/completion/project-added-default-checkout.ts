import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { captureBrowserLinkReveal } from '@/lib/browser/navigation/browser-link-reveal'
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
import { projectAddToastId } from '@/store/repos/repo-state'
import { selectExecutionHostDisplayLabel } from '@/runtime/hosts/display/execution-host-display-label'
import { worktreeMatchesHost } from '@/store/slices/worktrees/listing/worktree-host-ownership'
import {
  getHiddenExternalWorktrees,
  mergeExternalWorktreeInboxPaths
} from '../../../../../../shared/worktree/visibility/external-worktree-inbox'
import { markOnboardingProjectAdded } from '@/components/onboarding/onboarding-project-checklist'
import { finalizeImportedRepoAfterSkip } from './add-repo-skip-finalization'
import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import {
  selectDetectedWorktreesByRepo,
  selectWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'

type DefaultCheckoutHandoffReason = EventProps<'add_repo_default_checkout_handoff'>['reason']

let handoffGeneration = 0

function captureProjectCheckoutReveal() {
  const generation = ++handoffGeneration
  const initial = useAppStore.getState()
  return captureBrowserLinkReveal(useAppStore.getState, useAppStore.subscribe, () => {
    const state = useAppStore.getState()
    return (
      generation === handoffGeneration &&
      state.activeModal === initial.activeModal &&
      state.modalData === initial.modalData
    )
  })
}

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

export async function openProjectDefaultCheckout({
  repoId,
  source,
  selectedPath,
  executionHostId
}: {
  repoId: string
  source: AddRepoDefaultCheckoutHandoffSource
  selectedPath?: string
  executionHostId?: ExecutionHostId
}): Promise<void> {
  const reveal = captureProjectCheckoutReveal()
  try {
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
    finalizeImportedRepoAfterSkip(useAppStore.getState(), repoId)
    const description =
      !repo || !ownerHostId
        ? translate(
            'projectAdmission.checkout.ownerUnavailable',
            'The project host could not be identified. Add the project again from the intended host.'
          )
        : reason === 'show_detected_default_failed'
          ? translate(
              'projectAdmission.checkout.saveFailed',
              'Could not save the selected checkout’s visibility. Retry to open it.'
            )
          : reason === 'no_default_checkout' || reason === 'refreshed_default_missing'
            ? translate(
                'projectAdmission.checkout.missing',
                'The selected folder could not be matched to an available checkout on this host.'
              )
            : translate(
                'projectAdmission.checkout.refreshFailed',
                'Could not refresh checkouts on {{host}}. Retry when the host is available.',
                { host: selectExecutionHostDisplayLabel(useAppStore.getState(), ownerHostId) }
              )
    toast.error(
      translate('projectAdmission.checkout.openFailed', 'Could not open selected checkout'),
      {
        id: projectAddToastId(repoId),
        description,
        ...(repo && ownerHostId
          ? {
              action: {
                label: translate('common.retry', 'Retry'),
                onClick: () => {
                  void openProjectDefaultCheckout({
                    repoId,
                    source,
                    selectedPath,
                    executionHostId: ownerHostId
                  })
                }
              }
            }
          : {})
      }
    )
  } finally {
    reveal.dispose()
  }
}

export async function finishProjectAddWithDefaultCheckout({
  repoId,
  source,
  selectedPath,
  closeModal,
  executionHostId
}: {
  repoId: string
  source: AddRepoDefaultCheckoutHandoffSource
  selectedPath?: string
  closeModal: () => void
  executionHostId?: ExecutionHostId
}): Promise<void> {
  const reveal = captureProjectCheckoutReveal()
  try {
    await markOnboardingProjectAdded('addedRepo')
    if (!reveal.canReveal()) {
      return
    }
  } finally {
    reveal.dispose()
  }
  closeModal()
  await openProjectDefaultCheckout({
    repoId,
    source,
    selectedPath,
    executionHostId
  })
}
