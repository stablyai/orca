import type React from 'react'
import { Smartphone } from 'lucide-react'
import { CommandItem } from '@/components/ui/command'
import { RepoBadgeMark } from '@/components/repo/RepoBadgeLabel'
import { getPaletteHostBadge } from '@/components/cmd-j/palette-host-badge'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { BrowserPaletteItem, SimulatorPaletteItem } from './worktree-jump-palette-model'
import type { WorktreeJumpPaletteController } from './use-worktree-jump-palette-controller'
import {
  HighlightedText,
  PaletteHostBadgeChip,
  PaletteOpenTabPrimaryLine,
  PaletteRowShortcutBadge
} from './worktree-jump-palette-primitives'
import { formatPaletteSessionAge } from '@/components/cmd-j/palette-session-age'
import { resolvePaletteRepoForWorktree } from '@/lib/palette-repo-resolution'
import { BrowserFavicon } from '@/components/browser-favicon'

export function WorktreeJumpPaletteSimulatorRow({
  entry,
  renderKey,
  controller
}: {
  entry: SimulatorPaletteItem
  renderKey: string
  controller: WorktreeJumpPaletteController
}): React.JSX.Element {
  const result = entry.result
  const simulatorWorktree = controller.resolveWorktree(result.worktreeId, result.executionHostId)
  const simulatorRepo = simulatorWorktree
    ? resolvePaletteRepoForWorktree(
        simulatorWorktree,
        controller.repoMap,
        controller.repoByHostIdentity
      )
    : undefined
  const simulatorRepoName = simulatorRepo?.displayName ?? result.repoName
  const simulatorHostBadge = getPaletteHostBadge(
    simulatorRepo,
    controller.hostOptions,
    controller.hostFilterActive
  )
  const simulatorSessionAge = formatPaletteSessionAge(
    result.lastActiveAt ?? null,
    controller.paletteNowMs
  )

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
        <Smartphone className="size-3.5" aria-hidden="true" />
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
              sessionAge={simulatorSessionAge}
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
            <PaletteHostBadgeChip badge={simulatorHostBadge} />
            {simulatorRepoName && (
              <span className="inline-flex max-w-[180px] items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 text-[11px] font-semibold leading-none text-foreground">
                <RepoBadgeMark color={simulatorRepo?.badgeColor} />
                <span className="truncate">
                  <HighlightedText text={simulatorRepoName} matchRanges={result.repoRanges} />
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

export function WorktreeJumpPaletteBrowserRow({
  entry,
  renderKey,
  controller
}: {
  entry: BrowserPaletteItem
  renderKey: string
  controller: WorktreeJumpPaletteController
}): React.JSX.Element {
  const result = entry.result
  const browserWorktree = controller.resolveWorktree(result.worktreeId, result.executionHostId)
  const browserRepo = browserWorktree
    ? resolvePaletteRepoForWorktree(
        browserWorktree,
        controller.repoMap,
        controller.repoByHostIdentity
      )
    : undefined
  const browserRepoName = browserRepo?.displayName ?? result.repoName
  const browserHostBadge = getPaletteHostBadge(
    browserRepo,
    controller.hostOptions,
    controller.hostFilterActive
  )
  const browserSessionAge = formatPaletteSessionAge(
    result.lastActiveAt ?? null,
    controller.paletteNowMs
  )

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
        <BrowserFavicon faviconUrl={result.faviconUrl} className="size-3.5" />
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
              sessionAge={browserSessionAge}
              leadingBadges={
                <>
                  {result.isCurrentPage && (
                    <span className="shrink-0 self-center rounded-[6px] border border-border/60 bg-background/45 px-1.5 py-px text-[9px] font-medium leading-normal text-muted-foreground/88">
                      {translate('auto.components.WorktreeJumpPalette.52404f8096', 'Current Tab')}
                    </span>
                  )}
                  {!result.isCurrentPage && result.isCurrentWorktree && (
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
            <PaletteHostBadgeChip badge={browserHostBadge} />
            {browserRepoName && (
              <span className="inline-flex max-w-[180px] items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 text-[11px] font-semibold leading-none text-foreground">
                <RepoBadgeMark color={browserRepo?.badgeColor} />
                <span className="truncate">
                  <HighlightedText text={browserRepoName} matchRanges={result.repoRanges} />
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
