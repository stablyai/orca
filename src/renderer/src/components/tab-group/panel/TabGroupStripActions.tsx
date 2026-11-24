import { useRef, useState } from 'react'
import { cn } from '@/lib/class-names'
import type { TitlebarChromeFoldLevel } from '@/app-shell/chrome/titlebar-chrome-fold'
import { TabBarQuickCommandsButton } from '../../tab-bar/quick-commands/TabBarQuickCommandsButton'
import { TabGroupPaneActionsMenu } from './TabGroupPaneActionsMenu'

/** Quick commands and the pane ⋯ at the strip's right end. */
export function TabGroupStripActions({
  isFocused,
  worktreeId,
  groupId,
  onCloseGroup,
  foldLevel,
  onNewTab
}: {
  isFocused: boolean
  worktreeId: string
  groupId: string
  /** Only split groups can close their pane. */
  onCloseGroup: (() => void) | undefined
  foldLevel: TitlebarChromeFoldLevel
  onNewTab: () => void
}): React.JSX.Element {
  const quickCommandsSlotRef = useRef<HTMLDivElement>(null)
  const [paneActionsOpen, setPaneActionsOpen] = useState(false)
  if (!isFocused && paneActionsOpen) {
    setPaneActionsOpen(false)
  }
  return (
    // Why: actions hide before the tab bar's floor is reached; min-w-0 + clipping is only a backstop so reserved spacers stay clear.
    <div
      className={cn(
        'flex min-w-0 items-center gap-0.5 overflow-hidden pl-1.5 pr-0.5 transition-opacity duration-150',
        !isFocused && 'opacity-50 hover:opacity-100 focus-within:opacity-100'
      )}
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      {/* Why: drop an action whole (and from Tab order) once it can't fit beside the tab floor and "+", never leave a clipped focus target.
          163 = 40 tab + 36 "+" + 8 padding + 47 widest collapsed quick-command trigger + 2 gap + 28 pane actions + 2 sub-pixel slack; 114 = 40 + 36 + 8 + 28 + 2.
          A dropped trigger parks invisible at the pane's top-right edge, not display:none, so the shortcut menu keeps an anchor rect.
          Folded titlebar: the active tab's title outranks quick commands, so they always move into ⋯ (which offers a hidden slot's commands). */}
      <div
        ref={quickCommandsSlotRef}
        className={
          foldLevel > 0
            ? 'invisible absolute end-0 top-0 block'
            : 'contents @max-[163px]/tab-strip:invisible @max-[163px]/tab-strip:absolute @max-[163px]/tab-strip:end-0 @max-[163px]/tab-strip:top-0 @max-[163px]/tab-strip:block'
        }
      >
        <TabBarQuickCommandsButton
          worktreeId={worktreeId}
          groupId={groupId}
          isFocused={isFocused}
        />
      </div>
      {/* Folded titlebar chrome moves Back/Forward (and "+") into ⋯, so it shows without splits then. */}
      {onCloseGroup || foldLevel > 0 || paneActionsOpen ? (
        <TabGroupPaneActionsMenu
          isFocused={isFocused}
          open={paneActionsOpen}
          onOpenChange={setPaneActionsOpen}
          onCloseGroup={onCloseGroup}
          worktreeId={worktreeId}
          groupId={groupId}
          quickCommandsSlotRef={quickCommandsSlotRef}
          foldLevel={foldLevel}
          onNewTab={onNewTab}
        />
      ) : null}
    </div>
  )
}
