import { useCallback, type JSX } from 'react'
import { DropdownMenuCheckboxItem } from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import {
  EMPTY_RATE_LIMIT_WATCHER_TAB_IDS,
  EMPTY_WORKSPACE_TABS
} from './worktree-context-menu-policy'

// Why its own file and not another block inside WorktreeContextMenu.tsx: that
// file already sits at the max-lines lint ceiling.
//
// Why a checkbox rather than a plain item like Pin/Unpin: the watcher can press
// keys into a workspace's agent hours after the user walked away, so its armed
// state has to be readable at a glance, not inferred from a verb that flips.
//
// Why it reads the store itself instead of taking the armed set as a prop: the
// dropdown content only mounts while the menu is open, so the subscription
// lives exactly as long as the surface that needs it.
export function WorkspaceRateLimitWatcherMenuItem({
  worktreeId,
  disabled
}: {
  worktreeId: string
  disabled: boolean
}): JSX.Element {
  const rateLimitWatcherTabIds = useAppStore(
    (s) => s.rateLimitWatcherTabIds ?? EMPTY_RATE_LIMIT_WATCHER_TAB_IDS
  )
  const toggleRateLimitWatcher = useAppStore((s) => s.toggleRateLimitWatcher)
  const workspaceTabs = useAppStore((s) => s.tabsByWorktree[worktreeId] ?? EMPTY_WORKSPACE_TABS)
  // The storage stays per-terminal-tab (a tab is the unit the watcher acts on);
  // this workspace-level checkbox is a bulk surface over it: checked when every
  // tab is armed, one click arms or disarms them all. Sequential awaits so the
  // last snapshot the renderer stores is main's final authoritative set.
  const allTabsArmed =
    workspaceTabs.length > 0 &&
    workspaceTabs.every((tab) => rateLimitWatcherTabIds.includes(tab.id))
  const handleToggle = useCallback(() => {
    const enabled = !allTabsArmed
    void (async () => {
      for (const tab of workspaceTabs) {
        await toggleRateLimitWatcher(tab.id, enabled)
      }
    })()
  }, [allTabsArmed, workspaceTabs, toggleRateLimitWatcher])

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <DropdownMenuCheckboxItem
          checked={allTabsArmed}
          disabled={disabled || workspaceTabs.length === 0}
          onCheckedChange={handleToggle}
        >
          {translate(
            'auto.components.sidebar.WorktreeContextMenu.rateLimitWatcher',
            'Rate limit watcher'
          )}
        </DropdownMenuCheckboxItem>
      </TooltipTrigger>
      <TooltipContent side="right" sideOffset={8} className="max-w-[220px]">
        {translate(
          'auto.components.sidebar.WorktreeContextMenu.rateLimitWatcherDescription',
          "Wait for the provider usage limit to reset and resume this workspace's agent automatically."
        )}
      </TooltipContent>
    </Tooltip>
  )
}
