import React from 'react'
import { ShortcutKeyCombo } from './ShortcutKeyCombo'

/** The digit a held "select 1–9" shortcut would jump to, over the row it reaches; the parent must be positioned. */
export function IndexShortcutBadge({
  digit
}: {
  digit: string | undefined
}): React.JSX.Element | null {
  if (!digit) {
    return null
  }
  return (
    <span
      aria-hidden
      data-index-shortcut-badge=""
      className="pointer-events-none absolute top-1/2 right-1.5 z-20 -translate-y-1/2"
    >
      <ShortcutKeyCombo keys={[digit]} />
    </span>
  )
}
