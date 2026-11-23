import { useIndexShortcutHintVisible } from '@/lib/keyboard/index-shortcut-hints'
import { tabNumberShortcutDigit } from '@/lib/keyboard/tab-number-shortcuts'
import { useAppStateValue } from '@/store/retained-views/app-state-view'

/** While the tab "select 1–9" modifiers are held: the digit that reaches this tab, if any. */
export function useTabShortcutDigit(tabId: string): string | undefined {
  const visible = useIndexShortcutHintVisible('tab.selectByIndex')
  return useAppStateValue((state) => (visible ? tabNumberShortcutDigit(state, tabId) : undefined))
}
