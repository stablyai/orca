import type { Tab } from '../../../../shared/tab-types'
import type { TabBarProps } from '../tab-bar/tab-bar-props'

/** TabGroupPanel's single source of truth for mapping a group's active tab to the
 *  TabBar props that select it in the strip. Exported so tests can derive real
 *  props instead of hand-feeding a value production never produces (see B2). */
export function resolveTabGroupPanelActiveTabProps(
  activeTab: Tab | null
): Pick<TabBarProps, 'activeTabId' | 'activeFileId' | 'activeTabType'> {
  return {
    activeTabId:
      activeTab?.contentType === 'terminal'
        ? activeTab.entityId
        : activeTab?.contentType === 'agent-session' || activeTab?.contentType === 'agents'
          ? activeTab.id
          : null,
    activeFileId:
      activeTab?.contentType === 'terminal' ||
      activeTab?.contentType === 'agent-session' ||
      activeTab?.contentType === 'browser' ||
      activeTab?.contentType === 'simulator' ||
      activeTab?.contentType === 'agents'
        ? null
        : (activeTab?.id ?? null),
    activeTabType:
      activeTab?.contentType === 'terminal'
        ? 'terminal'
        : activeTab?.contentType === 'agent-session'
          ? 'agent-session'
          : activeTab?.contentType === 'browser'
            ? 'browser'
            : activeTab?.contentType === 'simulator'
              ? 'simulator'
              : activeTab?.contentType === 'agents'
                ? 'agents'
                : 'editor'
  }
}
