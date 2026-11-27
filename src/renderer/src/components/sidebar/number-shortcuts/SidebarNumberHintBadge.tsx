import React from 'react'
import { useShortcutKeyComboDetails } from '@/lib/keyboard/useShortcutLabel'
import { DIGIT_INDEX_ACTION_ID } from '../../worktree-jump/worktree-jump-palette-model'
import { PaletteRowShortcutBadge } from '../../worktree-jump/rows/worktree-jump-palette-row-content'
import { useSidebarNumberHint } from './sidebar-number-hints'

/** The row's Cmd/Ctrl+digit, the Cmd+J palette's chip, over its top-right corner while the modifier is held. Parent must be positioned. */
export function SidebarNumberHintBadge({ hintKey }: { hintKey: string }): React.JSX.Element | null {
  const index = useSidebarNumberHint(hintKey)
  return index === null ? null : <NumberHintChip index={index} />
}

// Split out so rows without a number never subscribe to the keybindings.
function NumberHintChip({ index }: { index: number }): React.JSX.Element {
  const modifierKeys = useShortcutKeyComboDetails(DIGIT_INDEX_ACTION_ID)[0]?.keys.slice(0, -1) ?? []
  return (
    // The sidebar's own fill keeps the row's title from showing through the chip's translucent caps.
    <span
      aria-hidden
      data-sidebar-number-hint={index + 1}
      className="pointer-events-none absolute top-1 right-1.5 z-20 inline-flex rounded bg-worktree-sidebar"
    >
      <PaletteRowShortcutBadge index={index} modifierKeys={modifierKeys} />
    </span>
  )
}
