import React, { useEffect } from 'react'
import { useAppStore } from '@/store'
import { HostGlyph } from '@/components/host-row-icon'
import {
  refreshCloudWorkspaceIds,
  useCloudWorkspace
} from '@/lib/orca-cloud/orca-cloud-workspace-store'
import { isCloudStatusRow } from '@/lib/orca-cloud/orca-cloud-workspace-rows'
import { isOrcaCloudRuntimeEnvironment } from '../../../../shared/remote-runtime/host-catalog/orca-cloud-environment-name'
import { CloudWorkspaceMark } from './CloudWorkspaceMark'
import { useIsOrcaCloudHost } from './WorkspaceHostGlyph'

/** The workspace's VM server is an Orca Cloud sandbox: known before the cloud id list catches up. */
function useRunsOnOrcaCloudSandbox(workspaceId: string): boolean {
  return useAppStore((state) => {
    const environmentId =
      state.ephemeralVmRuntimesByWorkspaceId?.[workspaceId]?.runtimeEnvironmentId
    if (!environmentId) {
      return false
    }
    const environment = state.runtimeEnvironments.find((entry) => entry.id === environmentId)
    return environment ? isOrcaCloudRuntimeEnvironment(environment) : false
  })
}

/** The card's host mark slot: Orca Cloud workspaces get the live cloud mark, others the fallback. */
export function CloudWorkspaceMarkSlot({
  workspaceId,
  hostId,
  fallback,
  onPointerDown
}: {
  workspaceId: string
  /** The workspace's execution host, when known: an Orca Cloud server means the cloud glyph. */
  hostId?: string | null
  fallback: React.ReactNode
  onPointerDown?: React.PointerEventHandler<HTMLButtonElement>
}): React.JSX.Element | null {
  // PAIRED-CHROME: a paired row's own checkout gets the live mark too (its status reads like an owned one's).
  const isCloud = useCloudWorkspace((s) => isCloudStatusRow(s, workspaceId))
  const onCloudHost = useIsOrcaCloudHost(hostId)
  const onCloudSandbox = useRunsOnOrcaCloudSandbox(workspaceId) || onCloudHost
  const awaitingId = onCloudSandbox && !isCloud
  // A new workspace joins the cloud id list on the next poll; ask now so its live mark arrives.
  useEffect(() => {
    if (awaitingId) {
      void refreshCloudWorkspaceIds()
    }
  }, [awaitingId])
  if (awaitingId) {
    // One glyph from the pending row on (NP-5): the cloud, never the server icon in between.
    return <HostGlyph kind="orca-cloud" size={12} />
  }
  if (!isCloud) {
    return <>{fallback}</>
  }
  return <CloudWorkspaceMark workspaceId={workspaceId} onPointerDown={onPointerDown} />
}
