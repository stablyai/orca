// Archive and unarchive from the team list. Both are lifecycle changes, never just a label:
// a workspace this desktop runs goes through the same Sleep → archive (with Undo) as the sidebar;
// any other one is archived by the control plane, which stops its sandbox and keeps a snapshot.
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { CloudWorkspaceResult } from '../../../../shared/hosted-sandbox/cloud-workspace-api'
import type { CloudWorkspace } from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import {
  runArchiveCloudWorkspace,
  runArchiveWithUndo,
  runUnarchiveCloudWorkspace
} from '../orca-cloud/cloud-workspace-actions'
import { describeError } from './cloud-workspace-errors'
export { usePendingHomeFilters } from './cloud-workspaces-home-nav'
import type { Translate } from '@/i18n/use-translate'
import { cloudWorkspaceTitle } from './open-cloud-workspace'

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
  localWorktreeId: async (sandboxId) =>
    (await window.api.cloudWorkspaces.localWorkspaces()).find(
      (local) => local.sandboxId === sandboxId && local.worktreeId
    )?.worktreeId ?? null,
  patchArchived: (sandboxId, archived) => window.api.cloudWorkspaces.patch(sandboxId, { archived }),
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

/** Row actions for the team list. A teammate's running workspace asks first (their agents stop). */
export function homeArchiveActions(options: {
  selfId: string | null
  t: Translate
  refresh: () => void
  confirmArchive: (pending: { kind: 'archive'; workspace: CloudWorkspace }) => void
}): { archive: (w: CloudWorkspace) => void; unarchive: (w: CloudWorkspace) => void } {
  const { selfId, t, refresh } = options
  return {
    archive: (w) => {
      if (w.ownerUserId !== selfId && w.status === 'running') {
        options.confirmArchive({ kind: 'archive', workspace: w })
        return
      }
      runHomeArchive(w, t, refresh)
    },
    unarchive: (w) => void unarchiveFromHome(w, cloudWorkspaceTitle(w, t)).finally(refresh)
  }
}
