import React, { useId } from 'react'
import { useAppStore } from '@/store/index'
import { useTranslate } from '@/i18n/use-translate'
import { SidebarHeaderActions } from './sidebar-header-actions'
import { SidebarSectionHeader } from '../SidebarSectionHeader'
import { PROJECTS_SECTION_GROUP_KEY } from '../../../../../shared/sidebar-list/sections/group-keys'
import { Button } from '@/components/ui/button'
import { Popover, PopoverAnchor, PopoverArrow, PopoverContent } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Sparkles, Bell, ChevronDown, FolderTree, GitBranch, Activity } from 'lucide-react'
import { cn } from '@/lib/class-names'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'

type SidebarHeaderProps = {
  activityBadgeTarget?: React.Ref<HTMLSpanElement>
  onWorkspaceBoardMenuOpenChange: (open: boolean) => void
  activityOptionsTarget?: React.Ref<HTMLDivElement>
  /** Only with Bots above it, so the sidebar never folds down to nothing. */
  collapsible?: boolean
  projectsCollapseTarget?: React.Ref<HTMLDivElement>
}

const SidebarHeader = React.memo(function SidebarHeader({
  activityBadgeTarget,
  onWorkspaceBoardMenuOpenChange,
  activityOptionsTarget,
  collapsible = false,
  projectsCollapseTarget
}: SidebarHeaderProps) {
  const t = useTranslate()
  const sidebarBody = useAppStore((s) => s.sidebarBody ?? 'workspaces')
  const groupBy = useAppStore((s) => s.groupBy)
  const chooseSidebarBody = useAppStore((s) => s.chooseSidebarBody)
  // Turning Activity off returns to the list it replaced.
  const listBodyRef = React.useRef<'conversations' | 'workspaces'>('workspaces')
  React.useEffect(() => {
    if (sidebarBody !== 'agents') {
      listBodyRef.current = sidebarBody
    }
  }, [sidebarBody])
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
  const workspaceTitle = t('dashboard.sidebar.workspaces', 'Workspaces')
  const projectsCollapsed = useAppStore(
    (s) => collapsible && s.collapsedGroups.has(PROJECTS_SECTION_GROUP_KEY)
  )
  const toggleCollapsedGroup = useAppStore((s) => s.toggleCollapsedGroup)
  const sidebarTitle =
    sidebarBody === 'conversations'
      ? t('dashboard.sidebar.projects', 'Projects')
      : sidebarBody === 'agents'
        ? t('dashboard.sidebar.activity', 'Activity')
        : workspaceTitle
  const activityLabel = t(
    agentsViewActive ? 'dashboard.sidebar.closeActivity' : 'dashboard.sidebar.openActivity',
    agentsViewActive ? 'Turn off activity view' : 'View activity'
  )

  const fold = collapsible
    ? {
        collapsed: projectsCollapsed,
        label: projectsCollapsed
          ? t('sidebar.projectsSection.expand', 'Expand {{title}}', { title: sidebarTitle })
          : t('sidebar.projectsSection.collapse', 'Collapse {{title}}', {
              title: sidebarTitle
            }),
        onToggle: () => toggleCollapsedGroup(PROJECTS_SECTION_GROUP_KEY)
      }
    : undefined

  return (
    <SidebarSectionHeader
      title={sidebarTitle}
      sectionId={groupBy === 'repo' ? 'projects' : 'workspaces'}
      fold={fold}
      titleControl={
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
                    ? 'activity'
                    : 'workspaces'
              }
            >
              {sidebarTitle}
              <ChevronDown aria-hidden="true" className="size-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem onSelect={() => chooseSidebarBody('conversations')}>
              <FolderTree />
              {t('dashboard.sidebar.projects', 'Projects')}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => chooseSidebarBody('workspaces')}>
              <GitBranch />
              {workspaceTitle}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => chooseSidebarBody('agents')}>
              <Activity />
              {t('dashboard.sidebar.activity', 'Activity')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      }
      tourTarget={groupBy === 'repo' ? 'projects-collapse-all' : undefined}
      // WorktreeList portals the collapse-all toggle here; it owns the rendered project rows.
      titleAccessory={
        <div
          ref={projectsCollapseTarget}
          className="relative flex shrink-0 items-center empty:hidden"
        />
      }

      actions={
        <>
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
                      onClick={() =>
                        chooseSidebarBody?.(agentsViewActive ? listBodyRef.current : 'agents')
                      }
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
                <p
                  id={introDescriptionId}
                  className="text-xs leading-relaxed text-muted-foreground"
                >
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
            conversationNavigation={sidebarBody === 'conversations'}
            agentsViewActive={sidebarBody !== 'workspaces'}
            activityOptionsTarget={activityOptionsTarget}
          />
        </>
      }
    />
  )
})

export default SidebarHeader
