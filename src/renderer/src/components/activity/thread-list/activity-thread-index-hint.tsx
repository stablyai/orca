import React from 'react'
import { ShortcutKeyCombo } from '@/components/ui/ShortcutKeyCombo'

/** Select-by-index number; takes the time's slot while the chord is held, so the row keeps its height. */
export function ActivityThreadIndexHint({ number }: { number: number }): React.JSX.Element {
  return <ShortcutKeyCombo keys={[String(number)]} size="compact" className="shrink-0" />
}
