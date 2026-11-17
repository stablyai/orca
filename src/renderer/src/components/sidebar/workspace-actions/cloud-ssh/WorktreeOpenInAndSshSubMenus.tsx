import type React from 'react'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { WorktreeRowOpenInSubMenu } from '../open/WorktreeRowOpenInSubMenu'
import { CloudSshEditorMenuItems, CloudSshMenuItems } from './CloudSshMenuItems'
import { useCloudSshMenuState } from './use-cloud-ssh-status'

/** "Open in" plus, for an Orca Cloud workspace, its editors over SSH and the "SSH" submenu.
 *  Mounted only while the row's menu is open, so the status is read fresh on each open. */
export function WorktreeOpenInAndSshSubMenus({
  worktree,
  connectionId,
  disabled
}: {
  worktree: Pick<Worktree, 'id' | 'path' | 'hostId' | 'runtimeOwnerEnvironmentId'>
  connectionId: string | null
  disabled?: boolean
}): React.JSX.Element {
  const cloud = useCloudSshMenuState(worktree)
  const status = cloud.kind === 'ready' ? cloud.status : null
  return (
    <>
      <WorktreeRowOpenInSubMenu
        worktree={worktree}
        connectionId={connectionId}
        disabled={disabled || cloud.kind === 'loading'}
        cloudEditors={
          cloud.kind === 'none' ? undefined : (
            <CloudSshEditorMenuItems
              workspaceId={worktree.id}
              status={status}
              disabled={disabled}
            />
          )
        }
      />
      {cloud.kind === 'none' ? null : (
        <CloudSshMenuItems workspaceId={worktree.id} status={status} disabled={disabled} />
      )}
    </>
  )
}
