import { useRef } from 'react'
import { cn } from '@/lib/class-names'
import { TabBarQuickCommandsButton } from '../tab-bar/TabBarQuickCommandsButton'
import { TabGroupPaneActionsMenu } from './TabGroupPaneActionsMenu'

export function TabGroupStripActions({
  worktreeId,
  groupId,
  isFocused,
  hasSplitGroups,
  onCloseGroup
}: {
  worktreeId: string
  groupId: string
  isFocused: boolean
  hasSplitGroups: boolean
  onCloseGroup: () => void
}): React.JSX.Element {
  const quickCommandsSlotRef = useRef<HTMLDivElement>(null)
  return (
    <div
      // Why: actions hide before the tab bar's floor is reached; min-w-0 + clipping is only a backstop so reserved spacers stay clear.
      className={cn(
        'flex min-w-0 items-center gap-0.5 overflow-hidden pl-1.5 pr-0.5 transition-opacity duration-150',
        !isFocused && 'opacity-50 hover:opacity-100 focus-within:opacity-100'
      )}
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
    >
      {/* Why: drop an action whole (and from Tab order) once it can't fit beside the tab floor and "+", never leave a clipped focus target.
          163 = 40 tab + 36 "+" + 8 padding + 47 widest collapsed quick-command trigger + 2 gap + 28 pane actions + 2 sub-pixel slack; 114 = 40 + 36 + 8 + 28 + 2. */}
      <div ref={quickCommandsSlotRef} className="contents @max-[163px]/tab-strip:hidden">
        <TabBarQuickCommandsButton
          worktreeId={worktreeId}
          groupId={groupId}
          isFocused={isFocused}
        />
      </div>
      {hasSplitGroups ? (
        <div className="contents @max-[114px]/tab-strip:hidden">
          <TabGroupPaneActionsMenu
            isFocused={isFocused}
            onCloseGroup={onCloseGroup}
            worktreeId={worktreeId}
            groupId={groupId}
            quickCommandsSlotRef={quickCommandsSlotRef}
          />
        </div>
      ) : null}
    </div>
  )
}
