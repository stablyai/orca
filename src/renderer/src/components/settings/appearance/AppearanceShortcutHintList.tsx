import type React from 'react'

import type { ShortcutKeyComboDetails } from '@/hooks/useShortcutLabel'
import { ShortcutKeyCombo } from '../../ShortcutKeyCombo'
import { useTranslate } from '@/i18n/use-translate'
import { translateUnassignedLabel } from '@/i18n/unassigned-label'

export function ShortcutHintList({
  combos
}: {
  combos: ShortcutKeyComboDetails[]
}): React.JSX.Element {
  useTranslate()
  if (combos.length === 0) {
    return <span className="text-xs text-muted-foreground">{translateUnassignedLabel()}</span>
  }
  const primaryCombo = combos[0]

  return (
    <span className="inline-flex items-center align-middle">
      <ShortcutKeyCombo
        keys={primaryCombo.keys}
        doubleTap={primaryCombo.doubleTap}
        className="inline-flex gap-0.5"
        separatorClassName="text-[10px] text-muted-foreground"
      />
    </span>
  )
}
