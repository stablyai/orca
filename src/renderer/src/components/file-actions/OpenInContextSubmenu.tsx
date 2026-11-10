import { useAppStateValue } from '@/store/retained-views/app-state-view'
import React, { useCallback } from 'react'
import { ExternalLink, FolderOpen } from 'lucide-react'
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger
} from '@/components/ui/context-menu'
import { OpenInApplicationIcon } from '@/lib/files/os-open/open-in-app-catalog'
import { NO_OPEN_IN_APPLICATIONS } from '@/lib/files/os-open/open-in-application-selection'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { OpenInApplication } from '../../../../shared/ui-chrome-types'
import { useTranslate } from '@/i18n/use-translate'
import {
  openOpenInAppsSettings,
  openWorktreePath
} from '@/components/sidebar/workspace-actions/open/WorktreeOpenInMenu'
import {
  getOpenInApplicationAvailability,
  useOpenInPathRoute
} from '@/components/sidebar/workspace-actions/open/use-open-in-path-route'

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
  const { route: openInRoute, workspace, runtimeSshHost } = useOpenInPathRoute(workspaceId, owner)

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
          const availability = getOpenInApplicationAvailability(
            application,
            openInRoute,
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
