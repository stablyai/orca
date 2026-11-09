import type { ShortcutKeyComboDetails } from '@/hooks/useShortcutLabel'
import { ShortcutKeyCombo } from '../ShortcutKeyCombo'

export function LandingRowLabel({ label }: { label: string }): React.JSX.Element {
  return <span className="min-w-0 flex-1 truncate text-left">{label}</span>
}

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
