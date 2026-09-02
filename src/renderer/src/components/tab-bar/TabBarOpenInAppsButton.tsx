import { useCallback, useMemo, useRef, useState } from 'react'
import { AppWindow, ChevronDown } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  getOpenInEntryAvailability,
  openOpenInAppsSettings,
  openWorktreePath,
  WorktreeOpenInMenuItems,
  type OpenInMenuEntry
} from '@/components/sidebar/WorktreeOpenInMenu'
import { OpenInApplicationIcon } from '@/lib/open-in-app-catalog'
import { NO_OPEN_IN_APPLICATIONS } from '@/lib/open-in-application-selection'
import { useAppStore } from '@/store'
import { findWorktreeById } from '@/store/slices/worktree-helpers'
import { translate } from '@/i18n/i18n'
import type { OpenInApplication } from '../../../../shared/ui-chrome-types'
import {
  TAB_BAR_ACTION_BUTTON_CLASS,
  TAB_BAR_SPLIT_BUTTON_CHEVRON_CLASS,
  TAB_BAR_SPLIT_BUTTON_CLASS,
  TAB_BAR_SPLIT_BUTTON_LABEL_CLASS,
  TAB_BAR_SPLIT_BUTTON_PRIMARY_CLASS
} from './tab-bar-split-button-chrome'

type TabBarOpenInAppsButtonProps = {
  worktreeId: string
}

function toOpenInEntry(application: OpenInApplication): OpenInMenuEntry {
  return {
    id: application.id,
    label: application.label,
    target: 'external-editor',
    command: application.command
  }
}

/** Split-button primary: the most recently launched app, else the first configured one (mirrors the quick-commands button). */
export function resolvePrimaryOpenInApplication(
  applications: readonly OpenInApplication[],
  recentId: string | null,
  isAvailable: (application: OpenInApplication) => boolean = () => true
): OpenInApplication | null {
  const recent = recentId
    ? applications.find((application) => application.id === recentId)
    : undefined
  if (recent && isAvailable(recent)) {
    return recent
  }
  // Why: on an SSH workspace the last-used app may be local-only, so prefer one that can open here.
  return applications.find(isAvailable) ?? recent ?? applications[0] ?? null
}

export function TabBarOpenInAppsButton({
  worktreeId
}: TabBarOpenInAppsButtonProps): React.JSX.Element | null {
  const worktreesByRepo = useAppStore((s) => s.worktreesByRepo)
  const repos = useAppStore((s) => s.repos)
  const settings = useAppStore((s) => s.settings)
  const openInApplications = useAppStore(
    (s) => s.settings?.openInApplications ?? NO_OPEN_IN_APPLICATIONS
  )
  const recentId = useAppStore((s) => s.recentOpenInApplicationId)
  const [menuOpen, setMenuOpen] = useState(false)
  const [moreAppsTooltipOpen, setMoreAppsTooltipOpen] = useState(false)
  // Why: closing the menu restores focus to the chevron, which must not immediately reopen its tooltip.
  const suppressMoreAppsTooltipRef = useRef(false)

  // Why: floating terminals use a synthetic worktree id with no workspace behind it, so there is nothing to open.
  const worktree = useMemo(
    () => findWorktreeById(worktreesByRepo, worktreeId) ?? null,
    [worktreesByRepo, worktreeId]
  )
  const connectionId = useMemo(
    () =>
      worktree ? (repos.find((repo) => repo.id === worktree.repoId)?.connectionId ?? null) : null,
    [repos, worktree]
  )
  const availabilityOf = useCallback(
    (application: OpenInApplication) =>
      getOpenInEntryAvailability(toOpenInEntry(application), settings, connectionId),
    [connectionId, settings]
  )
  const primary = useMemo(
    () =>
      resolvePrimaryOpenInApplication(
        openInApplications,
        recentId,
        (application) => !availabilityOf(application).disabled
      ),
    [availabilityOf, openInApplications, recentId]
  )
  const primaryAvailability = useMemo(
    () => (primary ? availabilityOf(primary) : { disabled: true }),
    [availabilityOf, primary]
  )

  const handleOpenChange = useCallback((next: boolean): void => {
    setMenuOpen(next)
    suppressMoreAppsTooltipRef.current = !next
    setMoreAppsTooltipOpen(false)
  }, [])
  const handleMoreAppsTooltipOpenChange = useCallback((next: boolean): void => {
    if (next && suppressMoreAppsTooltipRef.current) {
      return
    }
    setMoreAppsTooltipOpen(next)
  }, [])
  const allowMoreAppsTooltip = useCallback((): void => {
    suppressMoreAppsTooltipRef.current = false
  }, [])
  const openPrimary = useCallback((): void => {
    if (!primary || !worktree) {
      return
    }
    useAppStore.getState().setRecentOpenInApplicationId(primary.id)
    void openWorktreePath({
      target: 'external-editor',
      worktreePath: worktree.path,
      connectionId,
      command: primary.command
    })
  }, [connectionId, primary, worktree])

  if (!worktree) {
    return null
  }

  const addAppsLabel = translate(
    'auto.components.tab.bar.TabBarOpenInAppsButton.addApps',
    'Add apps to open this workspace in'
  )
  // Empty state: single button that jumps to the Open In Apps setting.
  if (!primary) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={openOpenInAppsSettings}
            className={TAB_BAR_ACTION_BUTTON_CLASS}
            aria-label={addAppsLabel}
          >
            <AppWindow className="size-3.5" />
            <span className="text-[12px] font-medium">
              {translate('auto.components.tab.bar.TabBarOpenInAppsButton.openIn', 'Open in')}
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {addAppsLabel}
        </TooltipContent>
      </Tooltip>
    )
  }

  const openPrimaryLabel = translate(
    'auto.components.tab.bar.TabBarOpenInAppsButton.openInApp',
    'Open in {{value0}}',
    { value0: primary.label }
  )
  const moreAppsLabel = translate(
    'auto.components.tab.bar.TabBarOpenInAppsButton.moreApps',
    'More apps'
  )
  return (
    <div className={TAB_BAR_SPLIT_BUTTON_CLASS}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={openPrimary}
            disabled={primaryAvailability.disabled}
            className={TAB_BAR_SPLIT_BUTTON_PRIMARY_CLASS}
            aria-label={openPrimaryLabel}
          >
            <OpenInApplicationIcon application={primary} size={12} />
            <span className={TAB_BAR_SPLIT_BUTTON_LABEL_CLASS}>{primary.label}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={6}>
          {openPrimaryLabel}
          {primaryAvailability.metadata ? (
            <span className="text-background/70"> · {primaryAvailability.metadata}</span>
          ) : null}
        </TooltipContent>
      </Tooltip>
      <DropdownMenu modal={false} open={menuOpen} onOpenChange={handleOpenChange}>
        <Tooltip open={moreAppsTooltipOpen} onOpenChange={handleMoreAppsTooltipOpenChange}>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={TAB_BAR_SPLIT_BUTTON_CHEVRON_CLASS}
                aria-label={moreAppsLabel}
                onPointerEnter={allowMoreAppsTooltip}
                onBlur={allowMoreAppsTooltip}
              >
                <ChevronDown className="size-3" strokeWidth={2.5} />
              </button>
            </DropdownMenuTrigger>
          </TooltipTrigger>
          <TooltipContent side="bottom" sideOffset={6}>
            {moreAppsLabel}
          </TooltipContent>
        </Tooltip>
        <DropdownMenuContent align="end" side="bottom" sideOffset={6} className="w-52">
          <WorktreeOpenInMenuItems
            worktreePath={worktree.path}
            connectionId={connectionId}
            includeFileManager={false}
            onOpenEntry={(entry) => useAppStore.getState().setRecentOpenInApplicationId(entry.id)}
          />
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={openOpenInAppsSettings}>
            {translate(
              'auto.components.sidebar.WorktreeOpenInMenu.1417fd8380',
              'Customize apps...'
            )}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
