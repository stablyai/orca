import type React from 'react'
import { useIsCloudWorkspace } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import { useAppStore } from '@/store'
import { DeleteWorktreeTargetPreview } from './DeleteWorktreeTargetPreview'
import type { Worktree } from '../../../../../../shared/worktree/types'
import {
  archiveInsteadOfDelete,
  DeleteCloudWorkspaceFooter,
  DeleteCloudWorkspaceHeader
} from './DeleteCloudWorkspaceParts'

/** The one Orca Cloud workspace this dialog deletes, or null (a batch, or not a cloud workspace). */
export function useCloudDeleteTarget(worktree: Worktree | null | undefined): Worktree | null {
  const isCloud = useIsCloudWorkspace(worktree?.id)
  return isCloud && worktree ? worktree : null
}

/** An Orca Cloud workspace gets its own heading; everything else keeps the dialog's own. */
export function CloudDeleteHeading({
  cloud,
  dirtyCounts,
  children
}: {
  cloud: Worktree | null
  dirtyCounts: React.ComponentProps<typeof DeleteCloudWorkspaceHeader>['dirtyCounts']
  children: React.ReactNode
}): React.JSX.Element {
  return cloud ? (
    <DeleteCloudWorkspaceHeader worktree={cloud} dirtyCounts={dirtyCounts} />
  ) : (
    <>{children}</>
  )
}

/** The local file preview has nothing to say about a cloud sandbox, so it is left out. */
export function LocalDeleteTargetPreview({
  cloud,
  ...props
}: React.ComponentProps<typeof DeleteWorktreeTargetPreview> & {
  cloud: Worktree | null
}): React.JSX.Element | null {
  return cloud ? null : <DeleteWorktreeTargetPreview {...props} />
}

/** Cloud: Cancel, Archive instead, Delete (the dialog is the consent: an asleep sandbox is
 *  deleted without waking it). Everything else keeps the dialog's own footer. */
export function CloudDeleteFooter({
  cloud,
  isDeleting,
  onCancel,
  onDelete,
  cancelButtonRef,
  children
}: {
  cloud: Worktree | null
  isDeleting: boolean
  onCancel: () => void
  onDelete: () => void
  cancelButtonRef: React.RefObject<HTMLButtonElement | null>
  children: React.ReactNode
}): React.JSX.Element {
  const closeModal = useAppStore((s) => s.closeModal)
  if (!cloud) {
    return <>{children}</>
  }
  return (
    <DeleteCloudWorkspaceFooter
      isDeleting={isDeleting}
      onCancel={onCancel}
      onArchive={() => archiveInsteadOfDelete(cloud, closeModal)}
      onDelete={onDelete}
      cancelButtonRef={cancelButtonRef}
    />
  )
}
