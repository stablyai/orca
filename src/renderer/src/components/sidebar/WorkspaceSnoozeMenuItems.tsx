import { useState, type JSX } from 'react'
import { AlarmClock, AlarmClockOff, CalendarClock } from 'lucide-react'
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import {
  WORKSPACE_SNOOZE_PRESETS,
  formatWorkspaceSnoozeWakeAt,
  resolveWorkspaceSnoozePresetWakeAt,
  workspaceSnoozePresetLabel
} from './workspace-snooze-presets'
import { isWorkspaceSnoozed } from '../../../../shared/workspace-snooze'
import type { WorktreeContextMenuModel } from './use-worktree-context-menu-model'

export function WorkspaceSnoozeMenuItems({
  model
}: {
  model: WorktreeContextMenuModel
}): JSX.Element {
  const {
    activeContextWorktrees,
    deletingContext,
    handlePickSnoozeTime,
    handleSnooze,
    handleWakeSnoozed
  } = model
  // Mixed selections show both actions; each applies only to the rows it fits.
  const canSnooze = activeContextWorktrees.some((item) => !isWorkspaceSnoozed(item))
  const canWake = activeContextWorktrees.some(isWorkspaceSnoozed)
  // Why a mount-time snapshot: menu content mounts on open, so preset times match that moment.
  const [now] = useState(() => new Date())
  return (
    <>
      {canSnooze ? (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger disabled={deletingContext}>
            <AlarmClock className="size-3.5" />
            {translate('auto.components.sidebar.workspaceSnooze.snooze', 'Snooze')}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="min-w-56">
            {WORKSPACE_SNOOZE_PRESETS.map((preset) => {
              const wakeAt = resolveWorkspaceSnoozePresetWakeAt(preset, now)
              return (
                <DropdownMenuItem key={preset} onSelect={() => handleSnooze(wakeAt)}>
                  {workspaceSnoozePresetLabel(preset)}
                  <span className="ml-auto shrink-0 pl-2 text-[11px] text-muted-foreground">
                    {formatWorkspaceSnoozeWakeAt(wakeAt, now)}
                  </span>
                </DropdownMenuItem>
              )
            })}
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={handlePickSnoozeTime}>
              <CalendarClock className="size-3.5" />
              {translate('auto.components.sidebar.workspaceSnooze.pickTime', 'Pick a Time…')}
            </DropdownMenuItem>
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      ) : null}
      {canWake ? (
        <DropdownMenuItem onSelect={handleWakeSnoozed} disabled={deletingContext}>
          <AlarmClockOff className="size-3.5" />
          {translate('auto.components.sidebar.workspaceSnooze.wakeNow', 'Wake Now')}
        </DropdownMenuItem>
      ) : null}
    </>
  )
}
