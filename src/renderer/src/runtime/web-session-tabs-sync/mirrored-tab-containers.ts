import type { MirroredHostTab, Tab } from '../../../../shared/tab-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { toWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'

export type MirroredTabContainers = {
  /** The association a tab built for this host tab saves. */
  origin: (hostTabId: string) => MirroredHostTab
  /** This client's tab for a host tab, whatever it held: the tab saved as mirroring it, else (once,
   *  for a tab saved before the association existed) the tab its id form or what it holds names. */
  containerOf: (hostTabId: string, contentHolder?: Tab) => Tab | undefined
  /** A new tab's id: the preferred one unless another tab here holds it. */
  allocate: (preferred: string) => string
}

/**
 * A paired client's tab for a host tab is found by the host tab it mirrors (`mirroredHostTab`:
 * host, workspace and the host's layout id, which a switch keeps), saved with the tab. What it
 * holds is separate, so a host switch changes the content under the same local tab, and its place,
 * pin and selection stay, on every load and whichever content it first showed. The local id is the
 * client's own and never decoded. A tab saved before the association existed is adopted once by
 * the id form it has always had (a terminal tab's `web-terminal-<id>`, a chat tab's own id) or by
 * what it holds, keeping its id. Another host's tabs, and a tab mirroring another host tab, are
 * never matched.
 */
export function mirroredTabContainers(
  unifiedTabs: readonly Tab[],
  hostId: ExecutionHostId,
  workspaceId: string
): MirroredTabContainers {
  const byHostTab = new Map<string, Tab>()
  const unassociated = new Map<string, Tab>()
  const occupied = new Set<string>()
  for (const tab of unifiedTabs) {
    occupied.add(tab.id)
    const origin = tab.mirroredHostTab
    if (!origin) {
      // Tabs saved before host stamping name no host; another host's never match.
      if (tab.executionHostId === undefined || tab.executionHostId === hostId) {
        unassociated.set(tab.id, tab)
      }
    } else if (origin.hostId === hostId && origin.workspaceId === workspaceId) {
      byHostTab.set(origin.tabId, tab)
    }
  }
  const claimed = new Set<string>()
  const claim = (tab: Tab | undefined): Tab | undefined => {
    if (tab) {
      claimed.add(tab.id)
    }
    return tab
  }
  const adoptable = (tab: Tab | undefined): Tab | undefined =>
    tab && unassociated.has(tab.id) && !claimed.has(tab.id) ? tab : undefined
  return {
    origin: (tabId) => ({ hostId, workspaceId, tabId }),
    containerOf: (hostTabId, contentHolder) =>
      claim(
        byHostTab.get(hostTabId) ??
          adoptable(unassociated.get(toWebTerminalSurfaceTabId(hostTabId))) ??
          adoptable(unassociated.get(hostTabId)) ??
          adoptable(contentHolder)
      ),
    allocate: (preferred) => {
      let id = preferred
      for (let suffix = 2; occupied.has(id); suffix++) {
        id = `${preferred}-${suffix}`
      }
      occupied.add(id)
      return id
    }
  }
}
