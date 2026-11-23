import React from 'react'
import { IndexShortcutBadge } from '@/components/ui/IndexShortcutBadge'
import { useTabShortcutDigit } from './use-tab-shortcut-digit'

/** Inside a tab's strip slot: the digit its "select tab 1–9" shortcut uses, while those modifiers are held. */
export function TabShortcutDigitBadge({ tabId }: { tabId: string }): React.JSX.Element | null {
  return <IndexShortcutBadge digit={useTabShortcutDigit(tabId)} />
}
