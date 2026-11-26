import { ShortcutKeyCombo } from '../ui/ShortcutKeyCombo'
import { WorktreeJumpPaletteTaskSearchStatus } from './tasks/worktree-jump-palette-task-search-status'
import type React from 'react'
import { X } from 'lucide-react'
import { CommandDialog, CommandEmpty, CommandInput, CommandList } from '@/components/ui/command'
import { TooltipProvider } from '@/components/ui/tooltip'
import PaletteFilterMenu from '@/components/cmd-j/PaletteFilterMenu'
import PaletteFilterChips from '@/components/cmd-j/PaletteFilterChips'
import { PaletteLiveStatusProvider } from '@/components/cmd-j/palette-live-status'
import { getPaletteFilterSelectionCount } from '@/components/cmd-j/palette-filter'
import { useTranslate } from '@/i18n/use-translate'
import { WorkspaceEmojiSuggestionPopover } from '@/components/workspace-emoji/WorkspaceEmojiSuggestionPopover'
import type { WorktreeJumpPaletteController } from './use-worktree-jump-palette-controller'
import { WorktreeJumpPaletteEntry } from './rows/worktree-jump-palette-entry'
import { FooterKey, PaletteState } from './rows/worktree-jump-palette-row-content'
import {
  getWorktreeJumpPaletteEmptyState,
  getWorktreeJumpPaletteResultCount
} from './results/worktree-jump-palette-empty-state'

const RESULT_KEYS = new Set(['Enter', 'ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp'])

export function WorktreeJumpPaletteSurface({
  controller,
  resultsReady,
  revealResultsNow
}: {
  controller: WorktreeJumpPaletteController
  resultsReady: boolean
  revealResultsNow: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const selectedTask = controller.taskItems.find(
    (item) => item.id === controller.commandSelectedItemId
  )
  const modKey = navigator.userAgent.includes('Mac') ? '⌘' : 'Ctrl'
  const emptyState = getWorktreeJumpPaletteEmptyState(controller, t)
  const resultCount = getWorktreeJumpPaletteResultCount(controller)
  const { scoped, botsEnabled } = controller.botScope
  const scopeHintId = 'worktree-jump-palette-bot-scope-hint'
  const placeholder = scoped
    ? t('bots.palette.scopedPlaceholder', 'Search bots...')
    : botsEnabled
      ? t(
          'bots.palette.placeholder',
          'Search bots, chats, terminals, workspaces, tasks, settings, and actions...'
        )
      : t(
          'auto.components.WorktreeJumpPalette.27f10cca63',
          'Search chats, terminals, workspaces, tasks, settings, and actions...'
        )
  const paletteDialog = (
    <CommandDialog
      open={controller.visible}
      onOpenChange={controller.handleOpenChange}
      shouldFilter={false}
      onOpenAutoFocus={controller.handleOpenAutoFocus}
      onCloseAutoFocus={controller.handleCloseAutoFocus}
      title={t('auto.components.WorktreeJumpPalette.4ee378034d', 'Jump to...')}
      description={
        botsEnabled
          ? t(
              'bots.palette.description',
              'Search bots, chats, terminals, workspaces, tasks, settings, and actions'
            )
          : t(
              'auto.components.WorktreeJumpPalette.2770f02910',
              'Search chats, terminals, workspaces, tasks, settings, and actions'
            )
      }
      surface="palette"
      contentClassName="top-[min(10%,4rem)] w-[900px] max-w-[96vw] max-h-[min(90vh,calc(100vh-1.5rem))] overflow-hidden"
      commandProps={{
        loop: true,
        value: controller.commandSelectedItemId,
        onValueChange: controller.handleCommandSelectionChange,
        className: 'jump-palette-command bg-transparent',
        onKeyDownCapture: (event: React.KeyboardEvent) => {
          // Ctrl/Cmd chords include cmdk's Ctrl+N/J/P/K list navigation.
          if (!resultsReady && (RESULT_KEYS.has(event.key) || event.ctrlKey || event.metaKey)) {
            revealResultsNow()
          }
          if (
            selectedTask &&
            event.key === 'Enter' &&
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
        placeholder={placeholder}
        truncatePlaceholder
        aria-label={scoped ? t('bots.palette.scopedLabel', 'Search bots') : placeholder}
        aria-describedby={botsEnabled && !scoped ? scopeHintId : undefined}
        value={controller.query}
        onValueChange={controller.emojiInput.handleValueChange}
        onClick={(event) => controller.emojiInput.syncCursor(event.currentTarget)}
        onSelect={(event) => controller.emojiInput.syncCursor(event.currentTarget)}
        onKeyDown={(event) => controller.emojiInput.handleKeyDown(event)}
        wrapperClassName="mx-3 mt-3 rounded-lg border border-border/55 bg-muted/28 px-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
        iconClassName="mr-2.5 h-4 w-4 text-muted-foreground/60"
        className="h-12 min-w-0 flex-1"
        leading={
          scoped ? (
            <button
              type="button"
              // Backspace is the keyboard path; Tab doesn't stop here.
              tabIndex={-1}
              aria-label={t('bots.palette.chipLabel', 'Bots, show everything')}
              className="mr-2 inline-flex shrink-0 items-center gap-1 rounded-md bg-accent px-1.5 py-0.5 text-[12px] font-medium text-foreground hover:bg-accent/80"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => controller.botScope.leaveBotScope('')}
            >
              {t('bots.palette.chip', 'Bots')}
              <X className="size-3 text-muted-foreground" aria-hidden="true" />
            </button>
          ) : null
        }
        trailing={
          <div ref={controller.setDialogElementFromNode} className="shrink-0">
            <PaletteFilterMenu
              model={controller.filterModel}
              filter={controller.filter}
              onFilterChange={controller.setFilter}
              onRequestInputFocus={controller.focusPaletteInput}
              portalContainer={controller.dialogElement}
              pausedReason={
                scoped
                  ? t('bots.palette.filtersPaused', 'Filters apply to workspaces, not bots')
                  : null
              }
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
      {botsEnabled && !scoped ? (
        <span id={scopeHintId} className="sr-only">
          {t('bots.palette.scopeHint', 'Type @ to show only bots')}
        </span>
      ) : null}
      {/* Paused while showing only bots, so nothing here can edit a filter that isn't applied. */}
      {scoped ? null : (
        <PaletteFilterChips
          model={controller.filterModel}
          filter={controller.filter}
          onFilterChange={controller.setFilter}
        />
      )}
      <CommandList
        ref={controller.listRef}
        onPointerDownCapture={() => {
          controller.selectionMovedByUserRef.current = true
        }}
        className="max-h-[min(600px,calc(100vh-14rem))] px-2.5 pb-2.5 pt-2"
      >
        {/* The opening frame paints only the input; results fill in on the next frame. */}
        {!resultsReady ? null : controller.isLoading &&
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
          <>
            {controller.botScopeNote ? (
              <div className="mx-0.5 mt-2 px-3 py-1.5 text-[12px] text-muted-foreground">
                {controller.botScopeNote}
              </div>
            ) : null}
            {controller.listEntries.map((entry, index) => (
              <WorktreeJumpPaletteEntry
                key={controller.listEntryRenderKeys[index] ?? entry.id}
                entry={entry}
                renderKey={controller.listEntryRenderKeys[index] ?? entry.id}
                controller={controller}
              />
            ))}
          </>
        )}
        <WorktreeJumpPaletteTaskSearchStatus
          loading={controller.taskSearchLoading}
          failures={controller.taskSearchFailures}
          onRetry={controller.retryTaskSearch}
        />
      </CommandList>
      <div className="flex items-center justify-end border-t border-border/60 px-3.5 py-2.5 text-[11px] text-muted-foreground/82">
        {/* Wraps on narrow windows and long translations instead of clipping its first keys. */}
        <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
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
          {scoped ? (
            <>
              <FooterKey>⌫</FooterKey>
              <span>{t('bots.palette.showEverything', 'Show everything')}</span>
            </>
          ) : (
            <>
              <FooterKey>{t('worktreeJumpPalette.filter.tabKey', 'Tab')}</FooterKey>
              <span>{t('worktreeJumpPalette.filter.label', 'Filter')}</span>
              {botsEnabled ? (
                <>
                  <FooterKey>@</FooterKey>
                  <span>{t('bots.palette.footerBots', 'Bots')}</span>
                </>
              ) : null}
            </>
          )}
        </div>
      </div>
      <div aria-live="polite" className="sr-only">
        {scoped
          ? t('bots.palette.scopedStatus', 'Showing only bots. {{count}} results found.', {
              count: controller.selectableItems.filter((item) => item.type === 'extra').length,
              defaultValue_one: 'Showing only bots. {{count}} result found.'
            })
          : null}
        {!scoped && controller.filterActive
          ? `${t('worktreeJumpPalette.filter.ariaActiveCount', 'Filter: {{count}} active.', {
              count: getPaletteFilterSelectionCount(controller.filter),
              defaultValue_one: 'Filter: {{count}} active.'
            })} `
          : ''}
        {scoped
          ? null
          : controller.deferredQuery.trim()
            ? t('auto.components.WorktreeJumpPalette.resultsFound', '{{count}} results found.', {
                count: resultCount,
                defaultValue_one: '{{count}} result found.'
              })
            : t(
                'auto.components.WorktreeJumpPalette.itemsAvailable',
                '{{count}} items available.',
                {
                  count: resultCount,
                  defaultValue_one: '{{count}} item available.'
                }
              )}
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
