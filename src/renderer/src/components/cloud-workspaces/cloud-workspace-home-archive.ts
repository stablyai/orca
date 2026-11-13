// Archive and unarchive from the cloud workspace list ("Open cloud workspace…"). Both are lifecycle changes, never just a label:
// a workspace this desktop runs goes through the same Sleep → archive (with Undo) as the sidebar;
// any other one is archived by the control plane, which stops its sandbox and keeps a snapshot.
import { noteCloudArchiveChanged } from '@/lib/orca-cloud/cloud-archive-changes'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { CloudWorkspaceResult } from '../../../../shared/hosted-sandbox/cloud-workspace-api'
import type { CloudWorkspace } from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import {
  runArchiveCloudWorkspace,
  runArchiveWithUndo,
  runRestartCloudWorkspace,
  runUnarchiveCloudWorkspace
} from '../orca-cloud/cloud-workspace-actions'
import { describeError } from './cloud-workspace-errors'
import type { Translate } from '@/i18n/use-translate'
import { cloudWorkspaceTitle } from './open-cloud-workspace'
import type { RowActions } from './CloudWorkspaceRowMenu'
import { runSleepWorktree } from '@/components/sidebar/workspace-actions/sleep/sleep-worktree-flow'
import { localWorktreeIdWithRow } from './cloud-local-row'
import { runWorktreeDelete } from '@/components/sidebar/workspace-actions/deletion/delete-worktree-flow'

export type HomeArchiveDeps = {
  localWorktreeId: (sandboxId: string) => Promise<string | null>
  patchArchived: (
    sandboxId: string,
    archived: boolean
  ) => ReturnType<typeof window.api.cloudWorkspaces.patch>
  archiveLocal: typeof runArchiveCloudWorkspace
  archiveWithUndo: typeof runArchiveWithUndo
  unarchiveLocal: typeof runUnarchiveCloudWorkspace
}

const defaultDeps = (): HomeArchiveDeps => ({
  localWorktreeId: localWorktreeIdWithRow,
  patchArchived: async (sandboxId, archived) => {
    const result = await window.api.cloudWorkspaces.patch(sandboxId, { archived })
    if (result.ok) {
      noteCloudArchiveChanged()
    }
    return result
  },
  archiveLocal: runArchiveCloudWorkspace,
  archiveWithUndo: runArchiveWithUndo,
  unarchiveLocal: runUnarchiveCloudWorkspace
})

function asResult(
  result: Awaited<ReturnType<HomeArchiveDeps['patchArchived']>>
): CloudWorkspaceResult<null> {
  if (result.ok) {
    return { ok: true, value: null }
  }
  const message =
    // The control plane refuses while the sandbox is starting or mid-transition (409, nothing changed).
    result.error === 'conflict'
      ? translate(
          'auto.components.cloudWorkspaces.archiveBusy',
          'This workspace is still starting or going to sleep. Nothing was changed. Try again in a moment.'
        )
      : describeError(result.error, result.reason, translate)
  return { ok: false, code: 'failed', message, userMessage: message }
}

/** The control plane archives a sandbox this window cannot archive itself (paired, or no row). */
export function archiveSandboxThroughControlPlane(
  sandboxId: string,
  name: string,
  deps: HomeArchiveDeps = defaultDeps()
): Promise<boolean> {
  return deps.archiveWithUndo(`home:${sandboxId}`, {
    name,
    commit: async () => asResult(await deps.patchArchived(sandboxId, true))
  })
}

export async function archiveFromHome(
  w: CloudWorkspace,
  name: string,
  deps: HomeArchiveDeps = defaultDeps()
): Promise<void> {
  const worktreeId = await deps.localWorktreeId(w.id)
  if (worktreeId) {
    await deps.archiveLocal(worktreeId, { name })
    return
  }
  await deps.archiveWithUndo(`home:${w.id}`, {
    name,
    commit: async () => asResult(await deps.patchArchived(w.id, true))
  })
}

export async function unarchiveFromHome(
  w: CloudWorkspace,
  name: string,
  deps: HomeArchiveDeps = defaultDeps()
): Promise<void> {
  const worktreeId = await deps.localWorktreeId(w.id)
  if (worktreeId) {
    // Same as the sidebar: the disk comes back and the workspace wakes.
    await deps.unarchiveLocal(worktreeId)
    return
  }
  const result = await deps.patchArchived(w.id, false)
  if (!result.ok) {
    toast.error(
      translate('orcaCloudWorkspace.unarchiveFailedNamed', 'Couldn’t unarchive {{name}}', { name }),
      {
        description: describeError(result.error, result.reason, translate)
      }
    )
    return
  }
  toast.success(translate('orcaCloudWorkspace.unarchivedNamed', 'Unarchived {{name}}', { name }), {
    description: translate(
      'orcaCloudWorkspace.unarchivedAsleep',
      'It’s asleep. Opening it wakes it.'
    )
  })
}

export function runHomeArchive(w: CloudWorkspace, t: Translate, refresh: () => void): void {
  void archiveFromHome(w, cloudWorkspaceTitle(w, t)).finally(refresh)
}

/** Sleep: this desktop's Sleep for a workspace it runs, else the control plane (owner or admin). */
export async function sleepFromHome(w: CloudWorkspace, name: string): Promise<void> {
  const worktreeId = await defaultDeps().localWorktreeId(w.id)
  if (worktreeId) {
    await runSleepWorktree(worktreeId)
    return
  }
  const result = await window.api.cloudWorkspaces.sleep(w.id)
  if (!result.ok) {
    toastCloudSleepFailureRemote(name, describeError(result.error, result.reason, translate))
  }
}

/** Delete: this desktop's delete dialog for a workspace it runs, else confirm then the control plane. */
export async function deleteFromHome(
  w: CloudWorkspace,
  confirmDelete: (pending: { kind: 'delete'; workspace: CloudWorkspace }) => void
): Promise<void> {
  const worktreeId = await defaultDeps().localWorktreeId(w.id)
  if (worktreeId) {
    // The sidebar's own funnel (REG-8): it opens the dialog with the confirmed row's host and
    // instance, which the dialog re-checks on Delete. A bare { worktreeId } has none, so every
    // Delete from Home was refused as "Workspace list changed".
    runWorktreeDelete(worktreeId)
    return
  }
  confirmDelete({ kind: 'delete', workspace: w })
}

export async function destroyFromHome(w: CloudWorkspace, name: string): Promise<void> {
  const result = await window.api.cloudWorkspaces.destroy(w.id)
  if (result.ok) {
    // It may have been an archived one: anything counting archived workspaces reads again.
    noteCloudArchiveChanged()
    toast.success(translate('orcaCloudWorkspace.deletedNamed', 'Deleted {{name}}', { name }))
    return
  }
  toast.error(
    translate('orcaCloudWorkspace.deleteFailedNamed', 'Couldn’t delete {{name}}', { name }),
    {
      description: describeError(result.error, result.reason, translate)
    }
  )
}

function toastCloudSleepFailureRemote(name: string, description: string): void {
  toast.error(
    translate('orcaCloudWorkspace.sleepFailedNamed', 'Couldn’t put {{name}} to sleep', { name }),
    { description }
  )
}

/** Row actions for the team list. A teammate's running workspace asks first (their agents stop). */
export function homeArchiveActions(options: {
  selfId: string | null
  t: Translate
  refresh: () => void
  confirmArchive: (pending: { kind: 'archive' | 'delete'; workspace: CloudWorkspace }) => void
}): Pick<RowActions, 'archive' | 'unarchive' | 'sleep' | 'remove' | 'restart'> {
  const { selfId, t, refresh } = options
  return {
    sleep: (w) => void sleepFromHome(w, cloudWorkspaceTitle(w, t)).finally(refresh),
    remove: (w) => void deleteFromHome(w, options.confirmArchive),
    archive: (w) => {
      if (w.ownerUserId !== selfId && w.status === 'running') {
        options.confirmArchive({ kind: 'archive', workspace: w })
        return
      }
      runHomeArchive(w, t, refresh)
    },
    unarchive: (w) => void unarchiveFromHome(w, cloudWorkspaceTitle(w, t)).finally(refresh),
    restart: (w) => void restartFromHome(w).finally(refresh)
  }
}

/** Restart runs through this desktop's runtime for it, as the sidebar's Restart does. */
async function restartFromHome(w: CloudWorkspace, deps = defaultDeps()): Promise<void> {
  const worktreeId = await deps.localWorktreeId(w.id)
  if (!worktreeId) {
    toast.error(
      translate(
        'auto.components.cloudWorkspaces.restartElsewhere',
        'Restart it from the computer that created it.'
      )
    )
    return
  }
  await runRestartCloudWorkspace(worktreeId)
}

/** The team list's confirm dialog was accepted for an archive or a delete. */
export function runConfirmed(
  pending: { kind: 'archive' | 'delete'; workspace: CloudWorkspace },
  t: Translate,
  refresh: () => void
): void {
  if (pending.kind === 'archive') {
    runHomeArchive(pending.workspace, t, refresh)
    return
  }
  void destroyFromHome(pending.workspace, cloudWorkspaceTitle(pending.workspace, t)).finally(
    refresh
  )
}
