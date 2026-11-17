// Orca Cloud work's additions to a pending create: the GitHub-only source, the VM build clock and
// failure fields the build sheet reads, and the sandbox glossary in the progress label.
import type { Translate } from '@/i18n/use-translate'
import type { GitHubCreateSource } from '@/lib/orca-cloud/github-create-source'
import { orcaCloudCloneProgress } from '@/lib/orca-cloud/orca-cloud-clone-progress'
import type { PendingWorktreeCreation, WorktreeCreationRequest } from './pending-worktree-creation'

export type WorktreeCreationRequestCloudFields = {
  /**
   * Orca Cloud from a GitHub repository with no clone here: the sandbox clones
   * it and this computer pairs to it. Same build sheet; Retry and Back to draft use this.
   */
  githubSource?: GitHubCreateSource
}

export type PendingVmEnvironmentCheckCloudFields = {
  startedAt?: number
  finishedAt?: number
  /** Orca Cloud, failed: when the unused sandbox is put to sleep so it stops spending hours. */
  sleepsAt?: number
  /** Orca Cloud, failed: the sandbox after that timer (absent while it still runs). */
  sandbox?: 'sleeping' | 'asleep' | 'deleted'
}

export type PendingWorktreeCreationCloudFields = {
  /** Machine-readable cause of `error`, e.g. `cloudPlanRequired`, so the sheet can offer the right fix. */
  errorCode?: string
  /** Set by the store when `status` turns to error. */
  errorAt?: number
  /** Arrival time of each line in `provisioningLog`, index-aligned with its lines. */
  provisioningLogStamps?: readonly number[]
  /** VM creates: since when failed checks have waited on the user; the build clock stops meanwhile. */
  waitingSince?: number
  /** VM creates: time already spent waiting on the user this run, left out of the build clock. */
  pausedMs?: number
  /** VM creates: when the user last resumed the build; the clock never reads earlier than this. */
  resumedAt?: number
  /** VM creates: the provisioned VM's runtime environment, known once it answers. */
  vmEnvironmentId?: string
  /** GitHub-only Orca Cloud create: the server it is pairing to; its rows wait for the hand-off. */
  pairingHostId?: string
}

/**
 * Orca Cloud's progress copy, or null to use the generic copy. Glossary: an Orca Cloud machine is
 * a sandbox ("VM" stays only for bring-your-own recipes), and the sandbox clones the repository;
 * there is no local worktree to create.
 */
export function orcaCloudCreationProgressLabel(
  entry: Pick<
    PendingWorktreeCreation,
    'phase' | 'indeterminate' | 'environmentCheck' | 'provisioningLog'
  > & { request: Pick<WorktreeCreationRequest, 'ephemeralVmRecipe'> },
  t: Translate
): string | null {
  if (entry.request.ephemeralVmRecipe?.provider !== 'orca-cloud') {
    return null
  }
  if (entry.phase === 'provisioning-vm') {
    if (entry.environmentCheck?.status === 'failed') {
      // Orca Cloud stops only on an unusable sandbox; the row says what the card says.
      return entry.environmentCheck.sandbox === 'asleep'
        ? t('auto.lib.pendingWorktreeCreation.cloudBlockedAsleep', 'Asleep')
        : t('auto.lib.pendingWorktreeCreation.cloudCouldNotOpen', 'Couldn’t open')
    }
    // Follows the build sheet's active step: sandbox, then the background clone, then checks.
    const clone = entry.environmentCheck
      ? null
      : orcaCloudCloneProgress(entry.provisioningLog ?? '', [])
    if (clone && !clone.ended) {
      return clone.mode === 'update'
        ? t('auto.lib.pendingWorktreeCreation.updatingRepository', 'Updating the repository…')
        : t('auto.lib.pendingWorktreeCreation.cloningRepository', 'Cloning the repository…')
    }
    return entry.environmentCheck || clone
      ? t('auto.lib.pendingWorktreeCreation.preparingCloudEnvironment', 'Preparing environment…')
      : t('auto.lib.pendingWorktreeCreation.startingSandbox', 'Starting sandbox…')
  }
  if (entry.indeterminate) {
    return null
  }
  return entry.phase === 'fetching'
    ? t('auto.lib.pendingWorktreeCreation.cloningRepository', 'Cloning the repository…')
    : t('auto.lib.pendingWorktreeCreation.settingUpWorkspace', 'Setting up your workspace…')
}
