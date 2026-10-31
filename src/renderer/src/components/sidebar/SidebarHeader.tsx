import React, { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { SidebarHeaderActions } from './sidebar-header-actions'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverArrow, PopoverContent } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Sparkles, Bell, ChevronDown, FolderTree, GitBranch, Activity } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AgentQuestionIcon } from '@/components/AgentQuestionIcon'
import { useAgentBucketCounts } from '@/components/dashboard/useAgentBucketCounts'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

type SidebarHeaderProps = {
  onWorkspaceBoardMenuOpenChange: (open: boolean) => void
  activityOptionsTarget?: React.Ref<HTMLDivElement>
}

const SidebarHeader = React.memo(function SidebarHeader({
  onWorkspaceBoardMenuOpenChange,
  activityOptionsTarget
}: SidebarHeaderProps) {
  // Subscribe this memoized header to locale changes before using translate().
  useTranslation()
  const sidebarBody = useAppStore((s) => s.sidebarBody ?? 'conversations')
  const setSidebarBody = useAppStore((s) => s.setSidebarBody)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const agentsViewActive = sidebarBody === 'agents'
  const counts = useAgentBucketCounts()
  const activityBadgeId = useId()
  const activityCount = counts.attention || counts.working
  const activityStatusLabel = counts.attention
    ? translate('dashboardPopout.bucket.attention', 'Needs You')
    : counts.working
      ? translate('dashboardPopout.bucket.working', 'Working')
      : translate('dashboardPopout.bucket.idle', 'Idle')
  const agentsSidebarIntroShown = useAppStore((s) => s.settings?.agentsSidebarIntroShown === true)
  const migratedFromExperimental = useAppStore(
    (s) => s.settings?.agentsSidebarMigratedFromExperimental === true
  )
  const introTitleId = useId()
  const introDescriptionId = useId()
  // Existing users who opted into the former Experimental Agents view get one explanation.
  const introOpen = migratedFromExperimental && !agentsSidebarIntroShown
  const acknowledgeIntro = React.useCallback(() => {
    void updateSettings?.({ agentsSidebarIntroShown: true })
  }, [updateSettings])
  const workspaceTitle = translate('dashboard.sidebar.workspaces', 'Workspaces')
  const sidebarTitle =
    sidebarBody === 'conversations'
      ? translate('dashboard.sidebar.projects', 'Projects')
      : sidebarBody === 'agents'
        ? translate('dashboard.sidebar.activity', 'Activity')
        : workspaceTitle
  const activityLabel = translate(
    agentsViewActive ? 'dashboard.sidebar.closeActivity' : 'dashboard.sidebar.openActivity',
    agentsViewActive ? 'Turn off activity view' : 'View activity'
  )

  return (
    <div className="mt-2 flex h-8 min-w-0 shrink-0 items-center justify-between gap-1.5 px-2">
      <div className="flex min-w-0 items-center gap-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="xs"
              // Truncate localized titles because fixed-width actions cannot shrink inside the short header row.
              className="min-w-0"
              data-sidebar-section-title={
                sidebarBody === 'conversations'
                  ? 'projects'
                  : sidebarBody === 'agents'
                    ? translate('dashboard.sidebar.activity', 'Activity')
                    : 'workspaces'
              }
            >
              {sidebarTitle}
              <ChevronDown aria-hidden="true" className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onSelect={() => setSidebarBody('conversations')}>
              <FolderTree />
              {translate('dashboard.sidebar.projects', 'Projects')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setSidebarBody('workspaces')}>
              <GitBranch />
              {workspaceTitle}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setSidebarBody('agents')}>
              <Activity />
              {translate('dashboard.sidebar.activity', 'Activity')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Popover
          open={introOpen}
          onOpenChange={(open) => {
            if (!open) {
              acknowledgeIntro()
            }
          }}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex shrink-0">
                <PopoverAnchor asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    className={cn(
                      'w-8 text-muted-foreground',
                      agentsViewActive &&
                        'bg-foreground/10 text-foreground hover:bg-foreground/15 dark:hover:bg-foreground/15'
                    )}
                    aria-label={activityLabel}
                    aria-pressed={agentsViewActive}
                    aria-describedby={activityBadgeId}
                    onClick={() => setSidebarBody?.(agentsViewActive ? 'conversations' : 'agents')}
                  >
                    <span className="relative h-5 w-6 shrink-0">
                      <Bell className="absolute left-0 top-1 size-3" />
                      <span
                        className="pointer-events-none absolute inset-0"
                        id={activityBadgeId}
                        aria-label={`${activityStatusLabel}: ${activityCount}`}
                      >
                        <span className="absolute right-0 top-0 flex h-2 w-3 items-center justify-center">
                          {counts.attention > 0 ? (
                            <AgentQuestionIcon className="size-2" />
                          ) : (
                            <span
                              className={cn(
                                'size-1 rounded-full',
                                counts.working > 0 ? 'bg-(--status-warning)' : 'bg-muted-foreground'
                              )}
                            />
                          )}
                        </span>
                        <span className="absolute right-0 top-2.5 flex h-2.5 w-3 items-center justify-center">
                          <span
                            className={cn(
                              'icon-superscript-count',
                              activityCount > 99 && 'origin-center scale-x-65'
                            )}
                            data-multiple-digits={activityCount > 9}
                          >
                            {activityCount > 99 ? '99+' : activityCount}
                          </span>
                        </span>
                      </span>
                    </span>
                  </Button>
                </PopoverAnchor>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>
              {activityLabel}
            </TooltipContent>
          </Tooltip>
          <PopoverContent
            side="bottom"
            align="center"
            sideOffset={8}
            className="w-72 rounded-xl border border-border bg-popover p-3.5 text-popover-foreground shadow-floating"
            onOpenAutoFocus={(event) => event.preventDefault()}
            aria-labelledby={introTitleId}
            aria-describedby={introDescriptionId}
          >
            <PopoverArrow />
            <div className="space-y-2.5">
              <div className="flex items-center gap-1.5">
                <Sparkles className="size-4 shrink-0 text-primary" aria-hidden="true" />
                <h3 id={introTitleId} className="text-sm font-semibold text-foreground">
                  {translate('agentsSidebarIntro.migrated.title', 'Agents are easier to find')}
                </h3>
              </div>
              <p id={introDescriptionId} className="text-xs leading-relaxed text-muted-foreground">
                {translate(
                  'agentsSidebarIntro.migrated.description',
                  'Your Agents view is now a dedicated sidebar tab. Your activity and filters are preserved.'
                )}
              </p>
              <div className="flex justify-end pt-0.5">
                <Button size="sm" onClick={acknowledgeIntro}>
                  {translate('agentsSidebarIntro.migrated.dismiss', 'Got it')}
                </Button>
              </div>
            </div>
          </PopoverContent>
        </Popover>
        <SidebarHeaderActions
          conversationNavigation={sidebarBody === 'conversations'}
          onWorkspaceBoardMenuOpenChange={onWorkspaceBoardMenuOpenChange}
          agentsViewActive={sidebarBody !== 'workspaces'}
          activityOptionsTarget={activityOptionsTarget}
        />
      </div>
    </div>
  )
})

export default SidebarHeader
