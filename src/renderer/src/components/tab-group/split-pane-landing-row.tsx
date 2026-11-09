import type { ShortcutKeyComboDetails } from '@/hooks/useShortcutLabel'
import { ShortcutKeyCombo } from '../ShortcutKeyCombo'

export const LANDING_ROW_CLASS =
  'flex h-9 w-full items-center gap-3 rounded-md px-2.5 text-sm text-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:text-accent-foreground focus-visible:outline-none'

export function LandingRowShortcut({
  shortcut
}: {
  shortcut: ShortcutKeyComboDetails
}): React.JSX.Element | null {
  if (shortcut.keys.length === 0) {
    return null
  }
  return (
    <ShortcutKeyCombo
      keys={shortcut.keys}
      doubleTap={shortcut.doubleTap}
      className="shrink-0"
      separatorClassName="mx-0.5 text-2xs text-muted-foreground"
      keyCapClassName="min-w-5 px-1 py-0 text-2xs leading-5 shadow-none"
    />
  )
}

/** Up/Down walk the rows like a menu; Tab still reaches the agent picker and Close pane. */
export function moveLandingRowFocus(
  event: React.KeyboardEvent<HTMLElement>,
  list: HTMLElement | null
): void {
  if (
    !list ||
    (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') ||
    // Why: the agent menu is portaled but still bubbles through React; leave its keys alone.
    !(event.target instanceof Node && list.contains(event.target))
  ) {
    return
  }
  const rows = Array.from(list.querySelectorAll<HTMLElement>('[data-landing-row]'))
  const active = document.activeElement
  const current = active instanceof HTMLElement ? rows.indexOf(active) : -1
  const step = event.key === 'ArrowDown' ? 1 : -1
  const next = rows[(current + step + rows.length) % rows.length]
  if (next) {
    event.preventDefault()
    next.focus()
  }
}
