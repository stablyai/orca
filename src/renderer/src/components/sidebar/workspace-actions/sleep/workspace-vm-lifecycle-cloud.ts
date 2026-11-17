// Orca Cloud side of the workspace menu's VM lifecycle item: Orca Cloud speaks the product's
// lifecycle verbs (Sleep / Wake), never "Suspend/Resume VM".
import type { Translate } from '@/i18n/use-translate'
import { useCloudWorkspace, useIsCloudWorkspace } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import {
  isArchivedCloudStatus,
  isPairedCloudStatusRow
} from '@/lib/orca-cloud/orca-cloud-workspace-rows'
import { wakeCloudWorkspace } from '@/components/orca-cloud/cloud-workspace-actions'
import { useCloudWorkspaceView } from '@/components/orca-cloud/use-cloud-workspace-view'
import type { CloudDotState } from '@/lib/orca-cloud/orca-cloud-workspace-state'
import type { WorkspaceVmLifecycleAction } from './WorkspaceVmLifecycleMenuItems'

/**
 * A paired cloud workspace (one this desktop opened or created from a GitHub-only
 * project) has no VM record here, so its lifecycle item follows the same state the sidebar line
 * shows (deriveCloudDotState: an in-flight wake first, then the control plane): Waking… while the
 * row reads Waking, Wake while it reads Asleep, Try waking again after a failed wake, and otherwise
 * the plain Sleep items (which reach the sandbox).
 */
export function getPairedCloudLifecycleAction(state: CloudDotState): {
  action: WorkspaceVmLifecycleAction
  retry: boolean
} {
  switch (state) {
    case 'waking':
      return { action: 'waking', retry: false }
    case 'sleeping':
      return { action: 'resume', retry: false }
    case 'wakeFailed':
      return { action: 'resume', retry: true }
    case 'running':
    case 'starting':
    case 'unresponsive':
    case 'failed':
    case 'archived':
    case 'unknown':
      return { action: null, retry: false }
  }
}

/** The cloud facts the lifecycle item reads. */
export function useCloudVmLifecycle(worktreeId: string): {
  cloud: boolean
  /** An archived cloud workspace (owned or paired) can't sleep or wake; Unarchive is its one
   *  lifecycle action, so neither Sleep nor Wake is offered here. */
  archived: boolean
  paired: { action: WorkspaceVmLifecycleAction; retry: boolean }
  wake: () => void
} {
  const cloud = useIsCloudWorkspace(worktreeId)
  const archived = useCloudWorkspace((state) =>
    isArchivedCloudStatus(state.status[worktreeId]?.status)
  )
  const isPaired = useCloudWorkspace((state) => isPairedCloudStatusRow(state, worktreeId))
  // The sidebar's own view of the row, so the menu never disagrees with the line beside it.
  const view = useCloudWorkspaceView(worktreeId, { pairedRows: true })
  const paired = isPaired
    ? getPairedCloudLifecycleAction(view.state)
    : { action: null, retry: false }
  return { cloud, archived, paired, wake: () => void wakeCloudWorkspace(worktreeId) }
}

/** The cloud wording of the lifecycle item, or null off Orca Cloud. */
export function cloudVmMenuLabels(
  cloud: boolean,
  retry: boolean,
  t: Translate
): { waking: string; resume: string; suspend: string; suspendDescription: string } | null {
  if (!cloud) {
    return null
  }
  return {
    waking: t('orcaCloudWorkspace.menu.waking', 'Waking…'),
    resume: retry
      ? t('orcaCloudWorkspace.menu.retryWake', 'Try waking again')
      : t('orcaCloudWorkspace.menu.wake', 'Wake'),
    suspend: t('orcaCloudWorkspace.menu.sleep', 'Sleep'),
    suspendDescription: t(
      'orcaCloudWorkspace.menu.sleepDescription',
      'Pauses the workspace until you open it again.'
    )
  }
}
