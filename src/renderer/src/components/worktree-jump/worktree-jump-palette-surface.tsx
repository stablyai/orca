import { ShortcutKeyCombo } from '../ShortcutKeyCombo'
import { WorktreeJumpPaletteTaskSearchStatus } from './worktree-jump-palette-task-search-status'
import React, { useCallback, useRef, useState } from 'react'
import { CommandDialog, CommandEmpty, CommandInput, CommandList } from '@/components/ui/command'
import { TooltipProvider } from '@/components/ui/tooltip'
import PaletteFilterMenu from '@/components/cmd-j/PaletteFilterMenu'
import PaletteFilterChips from '@/components/cmd-j/PaletteFilterChips'
import { PaletteLiveStatusProvider } from '@/components/cmd-j/palette-live-status'
import { getPaletteFilterSelectionCount } from '@/components/cmd-j/palette-filter'
import { useTranslate } from '@/i18n/use-translate'
import { WorkspaceEmojiSuggestionPopover } from '@/components/workspace-emoji/WorkspaceEmojiSuggestionPopover'
import type { WorktreeJumpPaletteController } from './use-worktree-jump-palette-controller'
import { useCommandInputActiveDescendant } from '@/lib/list-interaction/windowed-command-navigation'
import { isImeOwnedKeyboardEvent } from '@/lib/text-input/ime/ime-composition-keyboard-event'
import {
  handleWorktreeJumpPaletteListKeyDown,
  WorktreeJumpPaletteResultList
} from './worktree-jump-palette-result-list'
import { FooterKey, PaletteState } from './worktree-jump-palette-primitives'
import {
  getWorktreeJumpPaletteEmptyState,
  getWorktreeJumpPaletteResultCount
} from './worktree-jump-palette-empty-state'

export function WorktreeJumpPaletteSurface({
  controller
}: {
  controller: WorktreeJumpPaletteController
}): React.JSX.Element {
  const t = useTranslate()
  const selectedTask = controller.taskItems.find(
    (item) => item.id === controller.commandSelectedItemId
  )
  const modKey = navigator.userAgent.includes('Mac') ? '⌘' : 'Ctrl'
  const emptyState = getWorktreeJumpPaletteEmptyState(controller, t)
  const resultCount = getWorktreeJumpPaletteResultCount(controller)
  const { listRef } = controller
  const revealRef = useRef<(itemId: string) => void>(() => {})
  const [listElement, setListElement] = useState<HTMLDivElement | null>(null)
  const setListNode = useCallback(
    (node: HTMLDivElement | null) => {
      listRef.current = node
      setListElement(node)
    },
    [listRef]
  )
  useCommandInputActiveDescendant(controller.inputRef, controller.activeOptionId)
  const paletteDialog = (
    <CommandDialog
      open={controller.visible}
      onOpenChange={controller.handleOpenChange}
      shouldFilter={false}
      onOpenAutoFocus={controller.handleOpenAutoFocus}
      onCloseAutoFocus={controller.handleCloseAutoFocus}
      title={t('auto.components.WorktreeJumpPalette.4ee378034d', 'Jump to...')}
      description={t(
        'auto.components.WorktreeJumpPalette.2770f02910',
        'Search chats, terminals, workspaces, tasks, settings, and actions'
      )}
      surface="palette"
      contentClassName="top-[min(10%,4rem)] w-[900px] max-w-[96vw] max-h-[min(90vh,calc(100vh-1.5rem))] overflow-hidden"
      commandProps={{
        className: 'jump-palette-command bg-transparent',
        onKeyDownCapture: (event: React.KeyboardEvent) => {
          if (
            selectedTask &&
            event.key === 'Enter' &&
            !isImeOwnedKeyboardEvent(event) &&
            (navigator.userAgent.includes('Mac') ? event.metaKey : event.ctrlKey)
          ) {
            event.preventDefault()
            event.stopPropagation()
            controller.handleSelectTask(selectedTask.result, true)
            return
          }
          if (
            controller.selectionMovedByUserRef &&
            ['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp'].includes(event.key)
          ) {
            controller.selectionMovedByUserRef.current = true
          }
        }
      }}
    >
      <CommandInput
        ref={controller.inputRef}
        placeholder={t(
          'auto.components.WorktreeJumpPalette.27f10cca63',
          'Search chats, terminals, workspaces, tasks, settings, and actions...'
        )}
        value={controller.query}
        onValueChange={controller.emojiInput.handleValueChange}
        onClick={(event) => controller.emojiInput.syncCursor(event.currentTarget)}
        onSelect={(event) => controller.emojiInput.syncCursor(event.currentTarget)}
        onKeyDown={(event) => {
          if (!controller.emojiInput.handleKeyDown(event)) {
            handleWorktreeJumpPaletteListKeyDown(event, controller, revealRef)
          }
        }}
        wrapperClassName="mx-3 mt-3 rounded-lg border border-border/55 bg-muted/28 px-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
        iconClassName="mr-2.5 h-4 w-4 text-muted-foreground/60"
        className="h-12 min-w-0 flex-1"
        trailing={
          <div ref={controller.setDialogElementFromNode} className="shrink-0">
            <PaletteFilterMenu
              model={controller.filterModel}
              filter={controller.filter}
              onFilterChange={controller.setFilter}
              onRequestInputFocus={controller.focusPaletteInput}
              portalContainer={controller.dialogElement}
            />
          </div>
        }
      />
      <WorkspaceEmojiSuggestionPopover
        anchorRef={controller.inputRef}
        open={controller.emojiInput.open}
        commandValue={controller.emojiInput.commandValue}
        heading={t('auto.components.new.workspace.SmartWorkspaceNameField.emoji', 'Emoji')}
        suggestions={controller.emojiInput.suggestions}
        onCommandValueChange={controller.emojiInput.onCommandValueChange}
        onSelect={controller.emojiInput.selectSuggestion}
        onOpenChange={(open) => !open && controller.emojiInput.close()}
        portalContainer={controller.dialogElement}
        side="bottom"
        contentClassName="w-80"
      />
      <PaletteFilterChips
        model={controller.filterModel}
        filter={controller.filter}
        onFilterChange={controller.setFilter}
      />
      <CommandList
        ref={setListNode}
        onPointerDownCapture={() => {
          controller.selectionMovedByUserRef.current = true
        }}
        className="max-h-[min(600px,calc(100vh-14rem))] px-2.5 pb-2.5 pt-2"
      >
        {controller.isLoading &&
        controller.selectableItems.length === 0 &&
        !controller.showCreateAction ? (
          <PaletteState
            title={t('auto.components.WorktreeJumpPalette.ff908adfe9', 'Loading jump targets')}
            subtitle={t(
              'auto.components.WorktreeJumpPalette.684e8d7bc2',
              'Gathering your recent worktrees and open tabs.'
            )}
          />
        ) : controller.selectableItems.length === 0 && !controller.showCreateAction ? (
          <CommandEmpty className="py-0">
            <PaletteState title={emptyState.title} subtitle={emptyState.subtitle} />
          </CommandEmpty>
        ) : (
          <WorktreeJumpPaletteResultList
            controller={controller}
            scrollElement={listElement}
            revealRef={revealRef}
          />
        )}
        <WorktreeJumpPaletteTaskSearchStatus
          loading={controller.taskSearchLoading}
          failures={controller.taskSearchFailures}
          onRetry={controller.retryTaskSearch}
        />
      </CommandList>
      <div className="flex items-center justify-end border-t border-border/60 px-3.5 py-2.5 text-[11px] text-muted-foreground/82">
        <div className="flex items-center gap-2">
          {selectedTask ? (
            <>
              <ShortcutKeyCombo keys={[modKey, 'Enter']} />
              <span>{t('worktreeJumpPalette.taskCreate', 'Create workspace')}</span>
            </>
          ) : null}
          <FooterKey>{t('auto.components.WorktreeJumpPalette.f65d992a11', 'Enter')}</FooterKey>
          <span>{t('auto.components.WorktreeJumpPalette.45def60329', 'Open')}</span>
          <FooterKey>{t('auto.components.WorktreeJumpPalette.66b5a67bee', 'Esc')}</FooterKey>
          <span>{t('auto.components.WorktreeJumpPalette.75499e01d9', 'Close')}</span>
          <FooterKey>↑↓</FooterKey>
          <span>{t('auto.components.WorktreeJumpPalette.ac037cfac2', 'Move')}</span>
          <FooterKey>{t('worktreeJumpPalette.filter.tabKey', 'Tab')}</FooterKey>
          <span>{t('worktreeJumpPalette.filter.label', 'Filter')}</span>
        </div>
      </div>
      <div aria-live="polite" className="sr-only">
        {controller.filterActive
          ? `${t('worktreeJumpPalette.filter.ariaActiveCount', 'Filter: {{count}} active.', {
              count: getPaletteFilterSelectionCount(controller.filter),
              defaultValue_one: 'Filter: {{count}} active.'
            })} `
          : ''}
        {controller.deferredQuery.trim()
          ? t('auto.components.WorktreeJumpPalette.resultsFound', '{{count}} results found.', {
              count: resultCount,
              defaultValue_one: '{{count}} result found.'
            })
          : t('auto.components.WorktreeJumpPalette.itemsAvailable', '{{count}} items available.', {
              count: resultCount,
              defaultValue_one: '{{count}} item available.'
            })}
        {controller.showCreateAction
          ? ` ${t('auto.components.WorktreeJumpPalette.createActionAvailable', 'Create worktree action available.')}`
          : ''}
      </div>
    </CommandDialog>
  )

  return (
    <TooltipProvider>
      <PaletteLiveStatusProvider active={controller.paletteStatusInputsActive}>
        {paletteDialog}
      </PaletteLiveStatusProvider>
    </TooltipProvider>
  )
}
