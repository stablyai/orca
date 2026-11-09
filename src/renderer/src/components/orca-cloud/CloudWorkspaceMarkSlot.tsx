import React from 'react'
import { useIsCloudWorkspace } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import { CloudWorkspaceMark } from './CloudWorkspaceMark'

/** The card's host mark slot: Orca Cloud workspaces get the live cloud mark, others the fallback. */
export function CloudWorkspaceMarkSlot({
  workspaceId,
  fallback,
  onPointerDown
}: {
  workspaceId: string
  fallback: React.ReactNode
  onPointerDown?: React.PointerEventHandler<HTMLButtonElement>
}): React.JSX.Element | null {
  const isCloud = useIsCloudWorkspace(workspaceId)
  if (!isCloud) {
    return <>{fallback}</>
  }
  return <CloudWorkspaceMark workspaceId={workspaceId} onPointerDown={onPointerDown} />
}
