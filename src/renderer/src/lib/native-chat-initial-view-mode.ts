import type { GlobalSettings, Tab } from '../../../shared/types'

/**
 * Decide the initial `viewMode` for a newly launched agent tab from the
 * opt-in `openAgentTabsInChatByDefault` setting.
 *
 * Returns `'chat'` only when the setting is explicitly on; otherwise returns
 * `undefined` so the tab keeps the implicit default (`'terminal'`) and stays
 * backward-compatible with tabs persisted before the setting existed. A pure
 * function so the decision can be unit-tested without the store or launch path.
 */
export function decideInitialAgentTabViewMode(
  experimentalNativeChat: boolean | undefined,
  openAgentTabsInChatByDefault: boolean | undefined
): Tab['viewMode'] {
  return experimentalNativeChat === true && openAgentTabsInChatByDefault === true
    ? 'chat'
    : undefined
}

export function initialAgentTabViewModeProps(
  settings: Pick<GlobalSettings, 'experimentalNativeChat' | 'openAgentTabsInChatByDefault'> | null
): { viewMode?: Tab['viewMode'] } {
  const viewMode = decideInitialAgentTabViewMode(
    settings?.experimentalNativeChat,
    settings?.openAgentTabsInChatByDefault
  )
  return viewMode ? { viewMode } : {}
}
