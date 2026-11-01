import React, { useCallback } from 'react'
import { ExternalLink, FolderOpen } from 'lucide-react'
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger
} from '@/components/ui/context-menu'
import { useAppStore } from '@/store'
import { OpenInApplicationIcon } from '@/lib/open-in-app-catalog'
import { NO_OPEN_IN_APPLICATIONS } from '@/lib/open-in-application-selection'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { translate } from '@/i18n/i18n'
import { openOpenInAppsSettings, openWorktreePath } from '@/components/sidebar/WorktreeOpenInMenu'
import {
  getOpenInApplicationAvailability,
  useOpenInPathRoute
} from '@/components/sidebar/use-open-in-path-route'

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
  const openInApplications = useAppStore(
    (s) => s.settings?.openInApplications ?? NO_OPEN_IN_APPLICATIONS
  )
  const { route: openInRoute, workspace, runtimeSshHost } = useOpenInPathRoute(workspaceId, owner)

  const handleOpen = useCallback(
    (command: string) => {
      if (!path) {
        return
      }
      void openWorktreePath({
        target: 'external-editor',
        worktreePath: path,
        ...openInRoute,
        workspace,
        command,
        subject: 'path'
      })
    },
    [openInRoute, path, workspace]
  )

  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger disabled={!path}>
        <FolderOpen className="size-3.5" />
        {translate('auto.components.sidebar.WorktreeOpenInMenu.8009ab69a6', 'Open in')}
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className="w-52">
        {openInApplications.map((application) => {
          const availability = getOpenInApplicationAvailability(
            application,
            openInRoute,
            runtimeSshHost
          )
          return (
            <ContextMenuItem
              key={application.id}
              onSelect={() => handleOpen(application.command)}
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
          {translate('auto.components.sidebar.WorktreeOpenInMenu.1417fd8380', 'Customize apps...')}
        </ContextMenuItem>
      </ContextMenuSubContent>
    </ContextMenuSub>
  )
}
