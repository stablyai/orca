import React, { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { useAppStore } from '@/store'
import { useTranslate } from '@/i18n/use-translate'
import { SidebarHeaderActions } from './sidebar-header-actions'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverArrow, PopoverContent } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Sparkles, Bell } from 'lucide-react'
import { cn } from '@/lib/utils'

type SidebarHeaderProps = {
  activityBadgeTarget?: React.Ref<HTMLSpanElement>
  onWorkspaceBoardMenuOpenChange: (open: boolean) => void
  activityOptionsTarget?: React.Ref<HTMLDivElement>
  projectsCollapseTarget?: React.Ref<HTMLDivElement>
}

const SidebarHeader = React.memo(function SidebarHeader({
  activityBadgeTarget,
  onWorkspaceBoardMenuOpenChange,
  activityOptionsTarget,
  projectsCollapseTarget
}: SidebarHeaderProps) {
  const t = useTranslate()
  // Subscribe this memoized header to locale changes before using translate().
  useTranslation()
  const sidebarBody = useAppStore((s) => s.sidebarBody ?? 'workspaces')
  const groupBy = useAppStore((s) => s.groupBy)
  const setSidebarBody = useAppStore((s) => s.setSidebarBody)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const agentsViewActive = sidebarBody === 'agents'
  const activityBadgeId = useId()
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
  const sidebarTitle =
    groupBy === 'repo'
      ? t('dashboard.sidebar.projects', 'Projects')
      : t('dashboard.sidebar.workspaces', 'Workspaces')
  const activityLabel = t(
    agentsViewActive ? 'dashboard.sidebar.closeActivity' : 'dashboard.sidebar.openActivity',
    agentsViewActive ? 'Turn off activity view' : 'View activity'
  )

  return (
    <div className="group/sidebar-header mt-2 flex h-8 min-w-0 shrink-0 items-center justify-between gap-1.5 px-2">
      <div
        className="flex min-w-0 items-center"
        data-contextual-tour-target={groupBy === 'repo' ? 'projects-collapse-all' : undefined}
      >
        <span
          // Truncate localized titles because fixed-width actions cannot shrink inside the short header row.
          className="min-w-0 truncate select-none pl-2 pr-0.5 text-xs font-semibold text-muted-foreground/80"
          data-sidebar-section-title={groupBy === 'repo' ? 'projects' : 'workspaces'}
        >
          {sidebarTitle}
        </span>
        {/* WorktreeList portals the collapse-all toggle here; it owns the rendered project rows. */}
        <div ref={projectsCollapseTarget} className="flex shrink-0 items-center empty:hidden" />
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
                    onClick={() => setSidebarBody?.(agentsViewActive ? 'workspaces' : 'agents')}
                  >
                    <span className="relative h-5 w-6 shrink-0">
                      <Bell className="absolute left-0 top-1 size-3" />
                      <span
                        id={activityBadgeId}
                        ref={activityBadgeTarget}
                        className="pointer-events-none absolute inset-0"
                      />
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
                  {t('agentsSidebarIntro.migrated.title', 'Agents are easier to find')}
                </h3>
              </div>
              <p id={introDescriptionId} className="text-xs leading-relaxed text-muted-foreground">
                {t(
                  'agentsSidebarIntro.migrated.description',
                  'Your Agents view is now a dedicated sidebar tab. Your activity and filters are preserved.'
                )}
              </p>
              <div className="flex justify-end pt-0.5">
                <Button size="sm" onClick={acknowledgeIntro}>
                  {t('agentsSidebarIntro.migrated.dismiss', 'Got it')}
                </Button>
              </div>
            </div>
          </PopoverContent>
        </Popover>
        <SidebarHeaderActions
          onWorkspaceBoardMenuOpenChange={onWorkspaceBoardMenuOpenChange}
          agentsViewActive={agentsViewActive}
          activityOptionsTarget={activityOptionsTarget}
        />
      </div>
    </div>
  )
})

export default SidebarHeader
