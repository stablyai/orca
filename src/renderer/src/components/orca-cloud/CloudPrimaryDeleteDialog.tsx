// Delete for a cloud row that IS the cloud workspace (the sandbox's own
// checkout, shown as "primary"), including paired ones this desktop did not create. A local removal
// cannot delete it (Git keeps a primary checkout; a paired sandbox isn't this desktop's to destroy),
// so this is the cloud delete dialog from the sidebar, acting through the control plane:
// Delete destroys the sandbox, Archive instead archives it (with Undo).
import React, { useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import {
  DeleteCloudWorkspaceFooter,
  DeleteCloudWorkspaceHeader
} from '@/components/sidebar/workspace-actions/deletion/DeleteCloudWorkspaceParts'
import { describeError } from '@/components/cloud-workspaces/cloud-workspace-errors'
import { useAppStore } from '@/store'
import { runArchiveCloudWorkspace } from './cloud-workspace-actions'
import {
  noteCloudWorkspaceDeleteSettled,
  noteCloudWorkspaceDeleting
} from '@/lib/orca-cloud/pending-cloud-archive'
import { resolveCloudRowSandboxId } from '@/lib/orca-cloud/cloud-host-rows'
import { refreshCloudWorktreeBindings } from '@/components/cloud-workspaces/cloud-workspace-identity'
import {
  cloudPrimaryDeleteRequest,
  requestCloudPrimaryDelete,
  subscribeCloudPrimaryDelete,
  type CloudPrimaryDeleteTarget
} from '@/lib/orca-cloud/cloud-primary-delete-request'
import { openCloudWorkspacePicker } from '@/components/cloud-workspaces/cloud-workspace-picker-store'

type Target = CloudPrimaryDeleteTarget
const setRequested = requestCloudPrimaryDelete

const NO_SANDBOX = (): string =>
  translate(
    'orcaCloudWorkspace.primaryDelete.noSandbox2',
    "Orca couldn't find this workspace's sandbox. Find it in Open cloud workspace… to delete it."
  )

async function withSandbox(target: Target, run: (sandboxId: string) => Promise<void>) {
  const sandboxId = await resolveCloudRowSandboxId(target)
  if (!sandboxId) {
    toast.error(
      translate('orcaCloudWorkspace.deleteFailedNamed', 'Couldn’t delete {{name}}', {
        name: target.displayName ?? ''
      }),
      {
        description: NO_SANDBOX(),
        action: {
          label: translate('components.cloudWorkspaces.picker.menuItem', 'Open cloud workspace…'),
          onClick: () => openCloudWorkspacePicker()
        }
      }
    )
    return
  }
  await run(sandboxId)
}

/**
 * Destroys the sandbox (only "destroyed" counts) and refreshes what lists it. Runs in the
 * background like a local worktree delete: the row shows the shared removing state meanwhile, and
 * a failure restores it and says why in a toast.
 */
export async function destroyCloudPrimary(target: Target): Promise<void> {
  const name = target.displayName ?? ''
  const store = useAppStore.getState()
  const row = { id: target.id, hostId: target.hostId }
  // For cloud rows (owned or PAIRED), Delete cancels an archive still in its Undo window and
  // quiets one already under way, the same as the sidebar's ordinary delete.
  noteCloudWorkspaceDeleting(target.id)
  store.markWorktreesDeleting([row])
  let destroyed = false
  try {
    destroyed = await destroyCloudSandbox(target, name)
  } finally {
    noteCloudWorkspaceDeleteSettled(target.id)
    // Destroyed: the row stays "removing" until the bindings refresh drops it. Failed: it's back.
    if (!destroyed) {
      useAppStore.getState().clearWorktreeDeleteState(target.id, target.hostId)
    }
  }
}

async function destroyCloudSandbox(target: Target, name: string): Promise<boolean> {
  let destroyed = false
  await withSandbox(target, async (sandboxId) => {
    const result = await window.api.cloudWorkspaces.destroy(sandboxId)
    if (!result.ok) {
      toast.error(
        translate('orcaCloudWorkspace.deleteFailedNamed', 'Couldn’t delete {{name}}', { name }),
        { description: describeError(result.error, result.reason, translate) }
      )
      return
    }
    destroyed = true
    void refreshCloudWorktreeBindings().catch(() => undefined)
  })
  return destroyed
}

export function CloudPrimaryDeleteDialogMount(): React.JSX.Element | null {
  const target = useSyncExternalStore(subscribeCloudPrimaryDelete, cloudPrimaryDeleteRequest)
  if (!target) {
    return null
  }
  const close = (): void => setRequested(null)
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      {/* Same layout and focus as the local delete dialog: Cancel starts focused. */}
      <DialogContent
        size="confirm"
        surface="security"
        initialFocus="cancel"
        data-cloud-primary-delete=""
      >
        <DeleteCloudWorkspaceHeader worktree={target} dirtyCounts={new Map()} />
        <DeleteCloudWorkspaceFooter
          workspaceId={target.id}
          isDeleting={false}
          onArchive={() => {
            setRequested(null)
            // The ordinary archive: the archived page at once when it's in front, else Undo.
            void runArchiveCloudWorkspace(target.id, { name: target.displayName ?? null })
          }}
          onDelete={() => {
            // Like a local worktree delete: the dialog closes at once, the row shows it
            // removing, and the destroy runs in the background (a failure is a toast).
            setRequested(null)
            void destroyCloudPrimary(target)
          }}
        />
      </DialogContent>
    </Dialog>
  )
}
