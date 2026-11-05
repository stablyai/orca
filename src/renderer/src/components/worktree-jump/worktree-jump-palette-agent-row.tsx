import type React from 'react'
import { CommandItem } from '@/components/ui/command'
import { AgentStateDot } from '@/components/AgentStateDot'
import {
  activityThreadRowCopy,
  activityThreadStatusId,
  threadAgentStateLabel
} from '@/components/activity/activity-thread-presentation'
import { formatPaletteSessionAge } from '@/components/cmd-j/palette-session-age'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { AgentPaletteItem } from './worktree-jump-palette-model'
import type { WorktreeJumpPaletteController } from './use-worktree-jump-palette-controller'

export function WorktreeJumpPaletteAgentRow({
  entry,
  renderKey,
  controller
}: {
  entry: AgentPaletteItem
  renderKey: string
  controller: WorktreeJumpPaletteController
}): React.JSX.Element | null {
  const resolved = controller.resolveAgentRowThread(entry.paneKey)
  if (!resolved) {
    return null
  }
  const { thread, available } = resolved
  const copy = activityThreadRowCopy(thread)
  const stateLabel = threadAgentStateLabel(thread)
  const statusLine = available
    ? copy.statusLine && copy.statusLine !== stateLabel
      ? copy.statusLine
      : ''
    : translate('worktreeJumpPalette.agents.unavailable', 'No longer available')
  const age = formatPaletteSessionAge(thread.latestTimestamp, controller.paletteNowMs)

  return (
    <CommandItem
      value={renderKey}
      // Unavailable rows stay enabled so keyboard order never shifts; selecting them does nothing.
      onSelect={() => controller.handleSelectItem(entry)}
      className={cn(
        'group mx-0.5 flex cursor-pointer items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 text-left outline-none transition-[background-color,border-color,box-shadow]',
        'data-[selected=true]:border-border data-[selected=true]:bg-accent data-[selected=true]:text-foreground'
      )}
    >
      <div className="flex h-5 w-4 shrink-0 items-center justify-center self-start">
        <AgentStateDot state={activityThreadStatusId(thread)} size="sm" title={null} />
      </div>
      <div className="min-w-0 flex-1 overflow-hidden">
        <div className="flex items-center justify-between gap-2.5">
          <div className="flex min-w-0 flex-1 items-baseline gap-2 overflow-hidden">
            <span className="truncate text-sm font-medium text-foreground">{copy.taskTitle}</span>
            {age ? <span className="shrink-0 text-xs text-muted-foreground">{age}</span> : null}
          </div>
          <span className="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground">
            {copy.workspaceLabel}
          </span>
        </div>
        <div className="mt-0.5 flex min-w-0 items-baseline gap-1.5 text-xs text-muted-foreground">
          <span className="shrink-0 font-medium">{stateLabel}</span>
          {statusLine ? <span className="truncate">· {statusLine}</span> : null}
        </div>
      </div>
    </CommandItem>
  )
}
