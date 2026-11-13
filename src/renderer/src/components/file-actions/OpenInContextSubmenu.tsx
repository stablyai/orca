import { useAppStateValue } from '@/store/retained-views/app-state-view'
import React, { useCallback, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { ExternalLink, FolderOpen } from 'lucide-react'
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger
} from '@/components/ui/context-menu'
import { getRouteForLocalPathOpenOwner } from '@/lib/files/os-open/local-path-open-guard'
import { OpenInApplicationIcon } from '@/lib/files/os-open/open-in-app-catalog'
import { getWorkspaceEditorSshHost } from '@/components/file-actions/workspace-editor-ssh-target'
import { NO_OPEN_IN_APPLICATIONS } from '@/lib/files/os-open/open-in-application-selection'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { OpenInApplication } from '../../../../shared/ui-chrome-types'
import { useTranslate } from '@/i18n/use-translate'
import {
  getOpenInEntryAvailability,
  openOpenInAppsSettings,
  openWorktreePath
} from '@/components/sidebar/workspace-actions/open/WorktreeOpenInMenu'

type OpenInContextSubmenuProps = {
  path?: string
  workspaceId: string | null
  owner: ExecutionHostId | 'unresolved'
}

export function OpenInContextSubmenu({
  path,
  workspaceId,
  owner
}: OpenInContextSubmenuProps): React.JSX.Element {
  const t = useTranslate()
  const openInApplications = useAppStateValue(
    (s) => s.settings?.openInApplications ?? NO_OPEN_IN_APPLICATIONS
  )
  const openInRoute = useMemo(() => getRouteForLocalPathOpenOwner(owner), [owner])
  const workspace = useMemo(() => (workspaceId ? { workspaceId } : null), [workspaceId])
  const runtimeSshHost = useAppStateValue(
    useShallow((s) => getWorkspaceEditorSshHost(s, workspace))
  )

  const handleOpen = useCallback(
    (application: OpenInApplication) => {
      if (!path) {
        return
      }
      void openWorktreePath({
        target: 'external-editor',
        worktreePath: path,
        ...openInRoute,
        workspace,
        openInApplicationId: application.id,
        command: application.command,
        subject: 'path'
      })
    },
    [openInRoute, path, workspace]
  )

  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger disabled={!path}>
        <FolderOpen className="size-3.5" />
        {t('auto.components.sidebar.WorktreeOpenInMenu.8009ab69a6', 'Open in')}
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className="w-52">
        {openInApplications.map((application) => {
          const availability = getOpenInEntryAvailability(
            { ...application, target: 'external-editor' },
            openInRoute.connectionId,
            openInRoute.runtimeEnvironmentId,
            openInRoute.ownerUnresolved,
            runtimeSshHost,
            t
          )
          return (
            <ContextMenuItem
              key={application.id}
              onSelect={() => handleOpen(application)}
              disabled={!path || availability.disabled}
            >
              {application.command ? (
                <OpenInApplicationIcon application={application} size={14} />
              ) : (
                <ExternalLink className="size-3.5" />
              )}
              <span className="min-w-0 truncate">{application.label}</span>
              {availability.metadata ? (
                <span className="ml-auto shrink-0 text-2xs text-muted-foreground">
                  {availability.metadata}
                </span>
              ) : null}
            </ContextMenuItem>
          )
        })}
        {openInApplications.length > 0 ? <ContextMenuSeparator /> : null}
        <ContextMenuItem onSelect={openOpenInAppsSettings}>
          {t('auto.components.sidebar.WorktreeOpenInMenu.1417fd8380', 'Customize apps...')}
        </ContextMenuItem>
      </ContextMenuSubContent>
    </ContextMenuSub>
  )
}
