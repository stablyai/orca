import React from 'react'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'

/**
 * The 1-9 digit that jumps to this card, overlaid while the jump chord is held.
 *
 * Decorative on purpose: the shortcut is already announced by the keybindings
 * settings row, and an overlay that only exists mid-chord has nothing to add to
 * the accessibility tree.
 */
export function WorkspaceShortcutIndexBadge({ index }: { index: number }): React.JSX.Element {
  return (
    <span aria-hidden="true" data-workspace-shortcut-index-badge={index}>
      <ShortcutKeyCombo
        keys={[String(index)]}
        // Why the ring-strength border: the chip floats over hover/active card fills, and the plain sidebar border disappears against them.
        keyCapClassName="min-w-4 rounded-[4px] border-worktree-sidebar-ring/40 bg-worktree-sidebar-accent px-1 py-0 text-[10px] leading-4 text-worktree-sidebar-accent-foreground"
      />
    </span>
  )
}
