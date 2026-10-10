import type React from 'react'
import { flushSync } from 'react-dom'
import { CommandItem } from '@/components/ui/command'
import { cn } from '@/lib/utils'
import { PaletteCreateWorktreeRow } from '@/components/cmd-j/PaletteCreateWorktreeRow'
import type { PaletteListEntry } from './worktree-jump-palette-model'
import type { WorktreeJumpPaletteController } from './use-worktree-jump-palette-controller'
import { WorktreeJumpPaletteWorktreeRow } from './worktree-jump-palette-worktree-row'
import {
  WorktreeJumpPaletteActionRow,
  WorktreeJumpPaletteProjectRow
} from './worktree-jump-palette-project-action-rows'
import { WorktreeJumpPaletteWorkspaceTabRow } from './worktree-jump-palette-workspace-tab-row'
import {
  WorktreeJumpPaletteBrowserRow,
  WorktreeJumpPaletteSimulatorRow
} from './worktree-jump-palette-browser-simulator-rows'
import { translate } from '@/i18n/i18n'

export function WorktreeJumpPaletteEntry({
  entry,
  renderKey,
  controller
}: {
  entry: PaletteListEntry
  renderKey: string
  controller: WorktreeJumpPaletteController
}): React.JSX.Element {
  if (entry.type === 'section-header') {
    return (
      <div className="mx-0.5 mt-3 mb-1 px-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70">
        {entry.label}
      </div>
    )
  }
  if (entry.type === 'hint') {
    return (
      <CommandItem
        value={renderKey}
        onSelect={() => {
          const previousIndex = controller.selectionItemIds.indexOf(renderKey)
          flushSync(() => entry.onSeeMore?.())
          const expandedItemId = Array.from(
            controller.listRef.current?.querySelectorAll<HTMLElement>('[cmdk-item]') ?? []
          )[previousIndex]?.getAttribute('data-value')
          if (expandedItemId) {
            controller.setSelectedItemId(expandedItemId)
          }
          controller.inputRef.current?.focus()
        }}
        className={cn(
          'group mx-0.5 mt-1 min-h-0 gap-2 py-1.5 text-[12px] text-muted-foreground',
          'data-[selected=true]:bg-accent/60'
        )}
      >
        <span className="truncate">{entry.label}</span>
        {entry.onSeeMore ? (
          <span className="h-6 shrink-0 rounded-md border border-input bg-background px-2 text-xs font-medium leading-6 text-foreground">
            {translate('worktreeJumpPalette.seeMore', 'See more')}
          </span>
        ) : null}
      </CommandItem>
    )
  }
  if (entry.type === 'create-worktree') {
    const linearPreview = controller.currentLinearIssuePreview
    return (
      <PaletteCreateWorktreeRow
        className="group mx-0.5 mt-1 flex cursor-pointer items-center gap-3 rounded-lg border border-transparent px-3 py-1.5 text-left outline-none transition-[background-color,border-color,box-shadow] data-[selected=true]:border-border data-[selected=true]:bg-accent data-[selected=true]:text-foreground"
        createWorktreeName={controller.createWorktreeName}
        linearIdentifier={controller.linearIssueUrlIntent?.identifier ?? null}
        linearIssue={linearPreview?.issue ?? null}
        linearPending={controller.linearIssueUrlIntent !== null && linearPreview?.loading !== false}
        showLinearLoadingFeedback={controller.showLinearLoadingFeedback}
        taskUrlPreview={controller.taskUrlCreatePreview}
        onSelect={controller.handleCreateWorktree}
      />
    )
  }
  if (entry.type === 'worktree') {
    return (
      <WorktreeJumpPaletteWorktreeRow entry={entry} renderKey={renderKey} controller={controller} />
    )
  }
  if (entry.type === 'project-target') {
    return (
      <WorktreeJumpPaletteProjectRow entry={entry} renderKey={renderKey} controller={controller} />
    )
  }
  if (entry.type === 'settings' || entry.type === 'quick-action') {
    return (
      <WorktreeJumpPaletteActionRow entry={entry} renderKey={renderKey} controller={controller} />
    )
  }
  if (entry.type === 'workspace-tab') {
    return (
      <WorktreeJumpPaletteWorkspaceTabRow
        entry={entry}
        renderKey={renderKey}
        controller={controller}
      />
    )
  }
  if (entry.type === 'simulator-tab') {
    return (
      <WorktreeJumpPaletteSimulatorRow
        entry={entry}
        renderKey={renderKey}
        controller={controller}
      />
    )
  }
  return (
    <WorktreeJumpPaletteBrowserRow entry={entry} renderKey={renderKey} controller={controller} />
  )
}
