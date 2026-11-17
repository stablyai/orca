import type React from 'react'
import { useIsCloudWorkspace } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import { useAppStore } from '@/store'
import { DeleteWorktreeDialogFooter as LocalDeleteWorktreeDialogFooter } from './DeleteWorktreeDialogFooter'
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

/** Cloud: Archive on the left, then Cancel and Delete (the dialog is the consent: an asleep
 *  sandbox is deleted without waking it). Everything else keeps the dialog's own footer. */
export function DeleteWorktreeDialogFooter({
  cloud,
  onCloudDelete,
  ...props
}: React.ComponentProps<typeof LocalDeleteWorktreeDialogFooter> & {
  cloud: Worktree | null
  onCloudDelete: () => void
}): React.JSX.Element {
  const closeModal = useAppStore((s) => s.closeModal)
  if (!cloud) {
    return <LocalDeleteWorktreeDialogFooter {...props} />
  }
  return (
    <DeleteCloudWorkspaceFooter
      workspaceId={cloud.id}
      isDeleting={props.isDeleting}
      onArchive={() => archiveInsteadOfDelete(cloud, closeModal)}
      onDelete={onCloudDelete}
    />
  )
}
