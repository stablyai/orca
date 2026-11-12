// CLOUD-PRIMARY-DELETE: Delete for a cloud row that IS the cloud workspace (the sandbox's own
// checkout, shown as "primary"), including paired ones this desktop did not create. A local removal
// cannot delete it (Git keeps a primary checkout; a paired sandbox isn't this desktop's to destroy),
// so this is the cloud delete dialog from Home and the sidebar, acting through the control plane:
// Delete destroys the sandbox, Archive instead archives it (with Undo).
import React, { useRef, useState, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { Dialog, DialogContent, DialogFooter, DialogHeader } from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import {
  DeleteCloudWorkspaceFooter,
  DeleteCloudWorkspaceHeader
} from '@/components/sidebar/workspace-actions/deletion/DeleteCloudWorkspaceParts'
import { describeError } from '@/components/cloud-workspaces/cloud-workspace-errors'
import { archiveSandboxThroughControlPlane } from '@/components/cloud-workspaces/cloud-workspace-home-archive'
import { noteCloudArchiveChanged } from '@/lib/orca-cloud/cloud-archive-changes'
import { resolveCloudRowSandboxId } from '@/lib/orca-cloud/cloud-host-rows'
import { refreshCloudWorktreeBindings } from '@/components/cloud-workspaces/cloud-workspace-identity'
import {
  cloudPrimaryDeleteRequest,
  requestCloudPrimaryDelete,
  subscribeCloudPrimaryDelete,
  type CloudPrimaryDeleteTarget
} from '@/lib/orca-cloud/cloud-primary-delete-request'

type Target = CloudPrimaryDeleteTarget
const setRequested = requestCloudPrimaryDelete

const NO_SANDBOX = (): string =>
  translate(
    'orcaCloudWorkspace.primaryDelete.noSandbox',
    "Orca couldn't find this workspace's sandbox. Delete it from Cloud workspaces."
  )

async function withSandbox(target: Target, run: (sandboxId: string) => Promise<void>) {
  const sandboxId = await resolveCloudRowSandboxId(target)
  if (!sandboxId) {
    toast.error(
      translate('orcaCloudWorkspace.deleteFailedNamed', 'Couldn’t delete {{name}}', {
        name: target.displayName ?? ''
      }),
      { description: NO_SANDBOX() }
    )
    return
  }
  await run(sandboxId)
}

/** Destroys the sandbox (only "destroyed" counts) and refreshes what lists it. */
export async function destroyCloudPrimary(target: Target): Promise<void> {
  const name = target.displayName ?? ''
  await withSandbox(target, async (sandboxId) => {
    const result = await window.api.cloudWorkspaces.destroy(sandboxId)
    if (!result.ok) {
      toast.error(
        translate('orcaCloudWorkspace.deleteFailedNamed', 'Couldn’t delete {{name}}', { name }),
        { description: describeError(result.error, result.reason, translate) }
      )
      return
    }
    noteCloudArchiveChanged()
    void refreshCloudWorktreeBindings().catch(() => undefined)
    toast.success(translate('orcaCloudWorkspace.deletedNamed', 'Deleted {{name}}', { name }))
  })
}

export function CloudPrimaryDeleteDialogMount(): React.JSX.Element | null {
  const target = useSyncExternalStore(subscribeCloudPrimaryDelete, cloudPrimaryDeleteRequest)
  const [deleting, setDeleting] = useState(false)
  const cancelRef = useRef<HTMLButtonElement | null>(null)
  if (!target) {
    return null
  }
  const close = (): void => {
    if (!deleting) {
      setRequested(null)
    }
  }
  return (
    <Dialog open onOpenChange={(open) => !open && close()}>
      <DialogContent
        surface="security"
        className="max-w-md"
        data-cloud-primary-delete=""
        onOpenAutoFocus={(event) => {
          // Deleting the sandbox can't be undone: focus starts on Cancel, so Enter can't do it.
          event.preventDefault()
          cancelRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DeleteCloudWorkspaceHeader worktree={target} dirtyCounts={new Map()} />
        </DialogHeader>
        <DialogFooter>
          <DeleteCloudWorkspaceFooter
            isDeleting={deleting}
            cancelButtonRef={cancelRef}
            onCancel={close}
            onArchive={() => {
              setRequested(null)
              void withSandbox(target, async (sandboxId) => {
                await archiveSandboxThroughControlPlane(sandboxId, target.displayName ?? '')
              })
            }}
            onDelete={() => {
              setDeleting(true)
              void destroyCloudPrimary(target).finally(() => {
                setDeleting(false)
                setRequested(null)
              })
            }}
          />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
