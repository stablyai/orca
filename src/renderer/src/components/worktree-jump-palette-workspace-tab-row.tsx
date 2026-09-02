import type React from 'react'
import { FileText, SquareTerminal } from 'lucide-react'
import { AgentIcon } from '@/lib/agent-catalog'
import { CommandItem } from '@/components/ui/command'
import { PaletteRecentTabStatusDot } from '@/components/cmd-j/palette-live-status'
import { RepoBadgeMark } from '@/components/repo/RepoBadgeLabel'
import { getPaletteHostBadge } from '@/components/cmd-j/palette-host-badge'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { WorkspaceTabPaletteItem } from './worktree-jump-palette-model'
import type { WorktreeJumpPaletteController } from './use-worktree-jump-palette-controller'
import {
  HighlightedText,
  PaletteHostBadgeChip,
  PaletteOpenTabPrimaryLine,
  PaletteRowShortcutBadge
} from './worktree-jump-palette-primitives'
import { formatPaletteSessionAge } from '@/components/cmd-j/palette-session-age'
import { resolvePaletteRepoForWorktree } from '@/lib/palette-repo-resolution'

export function WorktreeJumpPaletteWorkspaceTabRow({
  entry,
  renderKey,
  controller
}: {
  entry: WorkspaceTabPaletteItem
  renderKey: string
  controller: WorktreeJumpPaletteController
}): React.JSX.Element {
  const result = entry.result
  const workspaceTabWorktree = controller.resolveWorktree(result.worktreeId, result.executionHostId)
  const workspaceTabRepo = workspaceTabWorktree
    ? resolvePaletteRepoForWorktree(
        workspaceTabWorktree,
        controller.repoMap,
        controller.repoByHostIdentity
      )
    : undefined
  const workspaceTabRepoName = workspaceTabRepo?.displayName ?? result.repoName
  const workspaceTabHostBadge = getPaletteHostBadge(
    workspaceTabRepo,
    controller.hostOptions,
    controller.hostFilterActive
  )
  const recentRow = controller.recentTabRowByItem.get(entry) ?? null
  const fallback =
    result.contentType === 'terminal' && result.occupantAgent ? (
      <span className="inline-flex" data-agent-icon={result.occupantAgent} aria-hidden="true">
        <AgentIcon agent={result.occupantAgent} size={14} />
      </span>
    ) : result.contentType === 'terminal' ? (
      <SquareTerminal className="size-3.5" aria-hidden="true" />
    ) : (
      <FileText className="size-3.5" aria-hidden="true" />
    )
  const sessionAge = formatPaletteSessionAge(result.lastActiveAt ?? null, controller.paletteNowMs)

  return (
    <CommandItem
      value={renderKey}
      onSelect={() => controller.handleSelectItem(entry)}
      className={cn(
        'group mx-0.5 flex cursor-pointer items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 text-left outline-none transition-[background-color,border-color,box-shadow]',
        'data-[selected=true]:border-border data-[selected=true]:bg-accent data-[selected=true]:text-foreground'
      )}
    >
      <div className="flex h-5 w-4 shrink-0 items-center justify-center self-start text-muted-foreground/85">
        <PaletteRecentTabStatusDot row={recentRow} fallback={fallback} />
      </div>
      <div className="min-w-0 flex-1 overflow-hidden">
        <div className="flex items-center justify-between gap-2.5">
          <div className="min-w-0 flex-1 overflow-hidden">
            <PaletteOpenTabPrimaryLine
              title={result.title}
              titleRanges={result.titleRanges}
              secondaryText={result.secondaryText}
              secondaryRanges={result.secondaryRanges}
              worktreeName={result.worktreeName}
              worktreeRanges={result.worktreeRanges}
              sessionAge={sessionAge}
              leadingBadges={
                <>
                  {result.isCurrentTab && (
                    <span className="shrink-0 self-center rounded-[6px] border border-border/60 bg-background/45 px-1.5 py-px text-[9px] font-medium leading-normal text-muted-foreground/88">
                      {translate('auto.components.WorktreeJumpPalette.52404f8096', 'Current Tab')}
                    </span>
                  )}
                  {!result.isCurrentTab && result.isCurrentWorktree && (
                    <span className="shrink-0 self-center rounded-[6px] border border-border/60 bg-background/45 px-1.5 py-px text-[9px] font-medium leading-normal text-muted-foreground/88">
                      {translate(
                        'auto.components.WorktreeJumpPalette.c5081f2814',
                        'Current Worktree'
                      )}
                    </span>
                  )}
                </>
              }
            />
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <PaletteHostBadgeChip badge={workspaceTabHostBadge} />
            {workspaceTabRepoName && (
              <span className="inline-flex max-w-[180px] items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 text-[11px] font-semibold leading-none text-foreground">
                <RepoBadgeMark color={workspaceTabRepo?.badgeColor} />
                <span className="truncate">
                  <HighlightedText text={workspaceTabRepoName} matchRanges={result.repoRanges} />
                </span>
              </span>
            )}
            <PaletteRowShortcutBadge
              index={controller.recentTabShortcutIndexByItem.get(entry)}
              modifierKeys={controller.digitShortcutModifiers}
            />
          </div>
        </div>
      </div>
    </CommandItem>
  )
}
