import type { Tab } from './tab-types'

export function structuredChatRowName(
  tab: Pick<Tab, 'customLabel' | 'label' | 'agentSessionAgent'> | undefined
): string | null {
  if (!tab) {
    return null
  }
  const custom = tab.customLabel?.trim()
  if (custom) {
    return custom
  }
  const label = tab.label.trim()
  return label || null
}
