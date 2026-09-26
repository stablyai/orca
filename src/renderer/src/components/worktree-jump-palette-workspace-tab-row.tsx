import type React from 'react'
import { FileText, Pin, PinOff, SquareTerminal } from 'lucide-react'
import { AgentIcon } from '@/lib/agent-catalog'
import { CommandItem } from '@/components/ui/command'
import { PaletteRecentTabStatusDot } from '@/components/cmd-j/palette-live-status'
import { getPaletteHostBadge } from '@/components/cmd-j/palette-host-badge'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import type { WorkspaceTabPaletteItem } from './worktree-jump-palette-model'
import type { WorktreeJumpPaletteController } from './use-worktree-jump-palette-controller'
import {
  PaletteHostBadgeChip,
  PaletteLocationChip,
  PaletteOpenTabPrimaryLine,
  PaletteRowShortcutBadge
} from './worktree-jump-palette-primitives'
import { formatPaletteSessionAge } from '@/components/cmd-j/palette-session-age'
import { resolvePaletteRepoForWorktree } from '@/lib/palette-repo-resolution'
import { isEditorTabContentType } from '@/store/slices/editor/tabs/editor-tab-content-type'

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
  const pinToggleLabel = result.isPinned
    ? translate('worktreeJumpPalette.pin.unpinTab', 'Unpin tab')
    : translate('worktreeJumpPalette.pin.pinTab', 'Pin tab')
  const stopRowSelect = (event: React.SyntheticEvent): void => {
    event.preventDefault()
    event.stopPropagation()
  }
  // Stop only the activation keys from reaching cmdk's root Enter handler (which
  // would otherwise select this row regardless of DOM focus); arrow/Home/End keys
  // must still bubble so palette keyboard navigation keeps working from this button.
  const stopActivationKeyPropagation = (event: React.KeyboardEvent): void => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.stopPropagation()
    }
  }

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
              secondaryMatches={result.secondaryMatches}
              elideSecondaryPathHead={isEditorTabContentType(result.contentType)}
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
            {result.typeAliasMatches.length ? (
              <span className="sr-only">
                {result.typeAliasMatches.map((match) => match.text).join(', ')}
              </span>
            ) : null}
          </div>
          <div className="flex min-w-0 max-w-[40%] items-center justify-end gap-1.5">
            <PaletteHostBadgeChip badge={workspaceTabHostBadge} />
            <PaletteLocationChip
              repoName={workspaceTabRepoName}
              repoRanges={result.repoRanges}
              repoColor={workspaceTabRepo?.badgeColor}
              worktreeName={result.worktreeName}
              worktreeRanges={result.worktreeRanges}
            />
            <PaletteRowShortcutBadge
              index={controller.recentTabShortcutIndexByItem.get(entry)}
              modifierKeys={controller.digitShortcutModifiers}
            />
            <button
              type="button"
              data-palette-pin-toggle="true"
              aria-label={pinToggleLabel}
              aria-pressed={result.isPinned}
              className={cn(
                'flex size-5 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 opacity-0 outline-none transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/50 group-hover:opacity-100 group-focus-within:opacity-100',
                result.isPinned && 'opacity-100 text-foreground'
              )}
              onPointerDown={stopRowSelect}
              onKeyDown={stopActivationKeyPropagation}
              onClick={(event) => {
                stopRowSelect(event)
                controller.handleToggleWorkspaceTabPinned(
                  result.tabId,
                  result.isPinned,
                  result.entityId,
                  result.contentType
                )
              }}
            >
              {result.isPinned ? (
                <PinOff className="size-3.5" aria-hidden="true" />
              ) : (
                <Pin className="size-3.5" aria-hidden="true" />
              )}
            </button>
          </div>
        </div>
      </div>
    </CommandItem>
  )
}
