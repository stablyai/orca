import React, { useEffect } from 'react'
import { RemoteDesktopMenuEntry } from '@/components/cloud-remote-desktop/RemoteDesktopMenuEntry'
import { openCloudRemoteDesktop } from '@/lib/cloud-remote-desktop/open-cloud-remote-desktop'
import {
  refreshCloudEnvironmentIds,
  useIsCloudEnvironment
} from '@/lib/cloud-remote-desktop/cloud-environment-ids'
import { useWorkspaceRuntimeEnvironmentId } from '@/lib/workspace/ownership/workspace-runtime-environment'

/** Cloud workspaces only. Mounted only inside the open menu. */
export function WorktreeRemoteDesktopMenuItem({
  worktreeId
}: {
  worktreeId: string
}): React.JSX.Element | null {
  const environmentId = useWorkspaceRuntimeEnvironmentId(worktreeId)
  const isCloud = useIsCloudEnvironment(environmentId)
  useEffect(() => {
    if (environmentId) {
      void refreshCloudEnvironmentIds()
    }
  }, [environmentId])
  if (!environmentId || !isCloud) {
    return null
  }
  return (
    <RemoteDesktopMenuEntry
      onSelect={() => void openCloudRemoteDesktop(worktreeId, environmentId)}
    />
  )
}
