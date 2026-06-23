import React, { useCallback } from 'react'
import { X } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { shouldShowProjectOrderManualDefaultNotice } from './project-order-manual-default-notice-visibility'
import { translate } from '@/i18n/i18n'

function ProjectOrderManualDefaultNotice(): React.JSX.Element | null {
  const persistedUIReady = useAppStore((s) => s.persistedUIReady)
  const projectOrderManualDefaultNoticeDismissed = useAppStore(
    (s) => s.projectOrderManualDefaultNoticeDismissed
  )
  const dismissProjectOrderManualDefaultNotice = useAppStore(
    (s) => s.dismissProjectOrderManualDefaultNotice
  )
  const groupBy = useAppStore((s) => s.groupBy)
  const projectOrderBy = useAppStore((s) => s.projectOrderBy)
  const repoCount = useAppStore((s) => s.repos.length)

  const shouldShow = shouldShowProjectOrderManualDefaultNotice({
    persistedUIReady,
    projectOrderManualDefaultNoticeDismissed,
    groupBy,
    projectOrderBy,
    repoCount
  })

  const handleDismiss = useCallback(() => {
    dismissProjectOrderManualDefaultNotice()
  }, [dismissProjectOrderManualDefaultNotice])

  if (!shouldShow) {
    return null
  }

  return (
    <div className="shrink-0 px-3 pb-2 pt-2">
      <div className="worktree-sidebar-notice-card worktree-sidebar-notice-card--to-section-title rounded-lg p-3 text-worktree-sidebar-foreground">
        <div className="flex items-start justify-between gap-2">
          <p className="min-w-0 text-sm font-semibold leading-snug text-worktree-sidebar-foreground">
            {translate(
              'auto.components.sidebar.ProjectOrderManualDefaultNotice.a1f4c2d8e0',
              'Manual project order is now the default'
            )}
          </p>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={translate(
                  'auto.components.sidebar.ProjectOrderManualDefaultNotice.822ff300ad',
                  'Dismiss'
                )}
                className="-mr-1 -mt-0.5 shrink-0 text-worktree-sidebar-foreground/60"
                onClick={handleDismiss}
              >
                <X className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={4}>
              {translate(
                'auto.components.sidebar.ProjectOrderManualDefaultNotice.822ff300ad',
                'Dismiss'
              )}
            </TooltipContent>
          </Tooltip>
        </div>
        <p className="mt-1 text-xs leading-snug text-worktree-sidebar-foreground/60">
          {translate(
            'auto.components.sidebar.ProjectOrderManualDefaultNotice.b7e3a91c4f',
            'Drag project headers to reorder, or switch to'
          )}{' '}
          <span className="font-medium text-worktree-sidebar-foreground">
            {translate('auto.components.sidebar.SidebarWorkspaceOptionsMenu.b451c8b162', 'Recent')}
          </span>{' '}
          {translate(
            'auto.components.sidebar.ProjectOrderManualDefaultNotice.e8c1f4a2b9',
            'in workspace options.'
          )}
        </p>
      </div>
    </div>
  )
}

export default React.memo(ProjectOrderManualDefaultNotice)
