import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStore } from '@/store'
import { getRouteForLocalPathOpenOwner } from '@/lib/local-path-open-guard'
import {
  getWorkspaceEditorSshHost,
  type WorkspaceEditorSshHost
} from '@/lib/workspace-editor-ssh-target'
import type { WorkspaceOwnerRef } from '@/lib/resolve-owner'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { OpenInApplication } from '../../../../shared/ui-chrome-types'
import { getOpenInEntryAvailability } from './WorktreeOpenInMenu'

export type OpenInPathRoute = ReturnType<typeof getRouteForLocalPathOpenOwner>

/** Where a workspace's paths live, as `openWorktreePath` and the Open In availability checks need it. */
export function useOpenInPathRoute(
  workspaceId: string | null,
  owner: ExecutionHostId | 'unresolved'
): {
  route: OpenInPathRoute
  workspace: WorkspaceOwnerRef | null
  runtimeSshHost: WorkspaceEditorSshHost | null
} {
  const route = useMemo(() => getRouteForLocalPathOpenOwner(owner), [owner])
  const workspace = useMemo(() => (workspaceId ? { workspaceId } : null), [workspaceId])
  const runtimeSshHost = useAppStore(useShallow((s) => getWorkspaceEditorSshHost(s, workspace)))
  return { route, workspace, runtimeSshHost }
}

export function getOpenInApplicationAvailability(
  application: OpenInApplication,
  route: OpenInPathRoute,
  runtimeSshHost: WorkspaceEditorSshHost | null
): ReturnType<typeof getOpenInEntryAvailability> {
  return getOpenInEntryAvailability(
    { ...application, target: 'external-editor' },
    route.connectionId,
    route.runtimeEnvironmentId,
    route.ownerUnresolved,
    runtimeSshHost
  )
}
