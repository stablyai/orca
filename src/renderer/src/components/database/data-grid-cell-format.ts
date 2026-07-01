// Shared cell display + copy for the result grids. NULL is rendered distinct
// from an empty string; objects (json/arrays) are stringified for display.

import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

export function formatCell(value: unknown): { text: string; isNull: boolean } {
  if (value === null || value === undefined) {
    return { text: 'NULL', isNull: true }
  }
  if (typeof value === 'object') {
    return { text: JSON.stringify(value), isNull: false }
  }
  return { text: String(value), isNull: false }
}

export function copyCell(value: unknown): void {
  const { text, isNull } = formatCell(value)
  // Only claim success once the write actually resolves — a rejected clipboard
  // write (no permission/focus) must not show a false "Copied" toast.
  navigator.clipboard
    .writeText(isNull ? '' : text)
    .then(() => toast.success(translate('auto.components.database.ResultsGrid.copied', 'Copied cell')))
    .catch(() => toast.error(translate('auto.components.database.ResultsGrid.copyFailed', 'Copy failed')))
}
