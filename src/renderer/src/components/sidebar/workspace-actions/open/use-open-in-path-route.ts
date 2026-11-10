import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useAppStateValue } from '@/store/retained-views/app-state-view'
import { getRouteForLocalPathOpenOwner } from '@/lib/files/os-open/local-path-open-guard'
import {
  getWorkspaceEditorSshHost,
  type WorkspaceEditorSshHost
} from '@/components/file-actions/workspace-editor-ssh-target'
import type { WorkspaceOwnerRef } from '@/lib/workspace/ownership/resolve-owner'
import type { Translate } from '@/i18n/use-translate'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { OpenInApplication } from '../../../../../../shared/ui-chrome-types'
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
  const runtimeSshHost = useAppStateValue(
    useShallow((s) => getWorkspaceEditorSshHost(s, workspace))
  )
  return { route, workspace, runtimeSshHost }
}

export function getOpenInApplicationAvailability(
  application: OpenInApplication,
  route: OpenInPathRoute,
  runtimeSshHost: WorkspaceEditorSshHost | null,
  t?: Translate
): ReturnType<typeof getOpenInEntryAvailability> {
  return getOpenInEntryAvailability(
    { ...application, target: 'external-editor' },
    route.connectionId,
    route.runtimeEnvironmentId,
    route.ownerUnresolved,
    runtimeSshHost,
    t
  )
}
