import type React from 'react'
import { CommandDialog, CommandEmpty, CommandInput, CommandList } from '@/components/ui/command'
import { TooltipProvider } from '@/components/ui/tooltip'
import PaletteFilterMenu from '@/components/cmd-j/PaletteFilterMenu'
import PaletteFilterChips from '@/components/cmd-j/PaletteFilterChips'
import { PaletteLiveStatusProvider } from '@/components/cmd-j/palette-live-status'
import { getPaletteFilterSelectionCount } from '@/components/cmd-j/palette-filter'
import { translate } from '@/i18n/i18n'
import { WorkspaceEmojiSuggestionPopover } from '@/components/workspace-emoji/WorkspaceEmojiSuggestionPopover'
import type { WorktreeJumpPaletteController } from './use-worktree-jump-palette-controller'
import { WorktreeJumpPaletteEntry } from './worktree-jump-palette-entry'
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
  const emptyState = getWorktreeJumpPaletteEmptyState(controller)
  const resultCount = getWorktreeJumpPaletteResultCount(controller)
  const paletteDialog = (
    <CommandDialog
      open={controller.visible}
      onOpenChange={controller.handleOpenChange}
      shouldFilter={false}
      onOpenAutoFocus={controller.handleOpenAutoFocus}
      onCloseAutoFocus={controller.handleCloseAutoFocus}
      title={translate('auto.components.WorktreeJumpPalette.4ee378034d', 'Jump to...')}
      description={translate(
        'auto.components.WorktreeJumpPalette.2770f02910',
        'Search chats, terminals, worktrees, settings, and actions'
      )}
      overlayClassName="bg-black/55 backdrop-blur-[2px]"
      contentClassName="top-[min(10%,4rem)] w-[900px] max-w-[96vw] max-h-[min(90vh,calc(100vh-1.5rem))] overflow-hidden rounded-xl border border-border/70 bg-background/96 shadow-[0_26px_84px_rgba(0,0,0,0.32)] backdrop-blur-xl"
      commandProps={{
        loop: true,
        value: controller.commandSelectedItemId,
        onValueChange: controller.handleCommandSelectionChange,
        className: 'bg-transparent',
        onKeyDownCapture: (event: React.KeyboardEvent) => {
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
        placeholder={translate(
          'auto.components.WorktreeJumpPalette.27f10cca63',
          'Search chats, terminals, worktrees, settings, and actions...'
        )}
        value={controller.query}
        onValueChange={controller.emojiInput.handleValueChange}
        onClick={(event) => controller.emojiInput.syncCursor(event.currentTarget)}
        onSelect={(event) => controller.emojiInput.syncCursor(event.currentTarget)}
        onKeyDown={(event) => controller.emojiInput.handleKeyDown(event)}
        wrapperClassName="mx-3 mt-3 rounded-lg border border-border/55 bg-muted/28 px-3.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]"
        iconClassName="mr-2.5 h-4 w-4 text-muted-foreground/60"
        className="h-12 text-[14px] placeholder:text-muted-foreground/75"
        trailing={
          <div ref={controller.setDialogElementFromNode}>
            <PaletteFilterMenu
              model={controller.filterModel}
              filter={controller.filter}
              onFilterChange={controller.setRawFilter}
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
        heading={translate('auto.components.new.workspace.SmartWorkspaceNameField.emoji', 'Emoji')}
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
        onFilterChange={controller.setRawFilter}
      />
      <CommandList
        ref={controller.listRef}
        onPointerDownCapture={() => {
          controller.selectionMovedByUserRef.current = true
        }}
        className="max-h-[min(600px,calc(100vh-14rem))] px-2.5 pb-2.5 pt-2"
      >
        {controller.isLoading &&
        controller.selectableItems.length === 0 &&
        !controller.showCreateAction ? (
          <PaletteState
            title={translate(
              'auto.components.WorktreeJumpPalette.ff908adfe9',
              'Loading jump targets'
            )}
            subtitle={translate(
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
      </CommandList>
      <div className="flex items-center justify-end border-t border-border/60 px-3.5 py-2.5 text-[11px] text-muted-foreground/82">
        <div className="flex items-center gap-2">
          <FooterKey>
            {translate('auto.components.WorktreeJumpPalette.f65d992a11', 'Enter')}
          </FooterKey>
          <span>{translate('auto.components.WorktreeJumpPalette.45def60329', 'Open')}</span>
          <FooterKey>
            {translate('auto.components.WorktreeJumpPalette.66b5a67bee', 'Esc')}
          </FooterKey>
          <span>{translate('auto.components.WorktreeJumpPalette.75499e01d9', 'Close')}</span>
          <FooterKey>↑↓</FooterKey>
          <span>{translate('auto.components.WorktreeJumpPalette.ac037cfac2', 'Move')}</span>
          <FooterKey>{translate('worktreeJumpPalette.filter.tabKey', 'Tab')}</FooterKey>
          <span>{translate('worktreeJumpPalette.filter.label', 'Filter')}</span>
        </div>
      </div>
      <div aria-live="polite" className="sr-only">
        {controller.filterActive
          ? `${translate('worktreeJumpPalette.filter.ariaActive', 'Filter: {{value0}} active.', {
              value0: getPaletteFilterSelectionCount(controller.filter)
            })} `
          : ''}
        {controller.deferredQuery.trim()
          ? translate(
              'auto.components.WorktreeJumpPalette.bb72c08e63',
              '{{value0}} results found{{value1}}',
              {
                value0: resultCount,
                value1: controller.showCreateAction ? ', create worktree action available' : ''
              }
            )
          : translate(
              'auto.components.WorktreeJumpPalette.20af998bff',
              '{{value0}} items available{{value1}}',
              {
                value0: resultCount,
                value1: controller.showCreateAction ? ', create worktree action available' : ''
              }
            )}
      </div>
    </CommandDialog>
  )

  return (
    <TooltipProvider delayDuration={400}>
      <PaletteLiveStatusProvider active={controller.paletteStatusInputsActive}>
        {paletteDialog}
      </PaletteLiveStatusProvider>
    </TooltipProvider>
  )
}
