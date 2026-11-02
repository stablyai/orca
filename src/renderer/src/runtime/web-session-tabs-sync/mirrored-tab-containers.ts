import type { MirroredHostTab, Tab } from '../../../../shared/tab-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { toWebTerminalSurfaceTabId } from '../../../../shared/terminal-surface-id'

/** What the index reads of a local tab: the snapshot mirror's tabs and the frame codec's alike. */
export type ContainerTab = Pick<Tab, 'id' | 'mirroredHostTab' | 'executionHostId'>

export type MirroredTabContainers<T extends ContainerTab = Tab> = {
  /** The association a tab built for this host tab saves. */
  origin: (hostTabId: string) => MirroredHostTab
  /** This client's tab for a host tab, whatever it holds: the tab saved as mirroring it, else (once,
   *  for a tab saved before the association existed) the tab its id form or what it holds names,
   *  else a new id, the preferred one unless another tab here has it. One answer per host tab for
   *  the whole batch. */
  resolve: (
    hostTabId: string,
    contentHolder: T | undefined,
    preferred: string
  ) => {
    id: string
    tab?: T
  }
}

/**
 * A paired client's tab for a host tab is found by the host tab it mirrors (`mirroredHostTab`:
 * host, workspace and the host's layout id, which a switch keeps), saved with the tab. What it
 * holds is separate, so a host switch changes the content under the same local tab, and its place,
 * pin and selection stay, on every load and whichever content it first showed. The local id is the
 * client's own and never decoded. A tab saved before the association existed is adopted once by
 * the id form it has always had (a terminal tab's `web-terminal-<id>`, a chat tab's own id) or by
 * what it holds, keeping its id. A tab mirroring another host tab is never matched, nor another
 * host's tab by id (two hosts reuse ids); what a tab holds is matched on any host, since the
 * content's own id names it everywhere. The snapshot mirror and the main-owned frame codec both
 * draw through this one index, so a workspace moving between them keeps its tabs.
 */
export function mirroredTabContainers<T extends ContainerTab>(
  unifiedTabs: readonly T[],
  hostId: ExecutionHostId,
  workspaceId: string
): MirroredTabContainers<T> {
  const byHostTab = new Map<string, T>()
  const unassociated = new Map<string, T>()
  const occupied = new Set<string>()
  for (const tab of unifiedTabs) {
    occupied.add(tab.id)
    const origin = tab.mirroredHostTab
    if (!origin) {
      unassociated.set(tab.id, tab)
    } else if (origin.hostId === hostId && origin.workspaceId === workspaceId) {
      byHostTab.set(origin.tabId, tab)
    }
  }
  const claimed = new Set<string>()
  const resolved = new Map<string, { id: string; tab?: T }>()
  const adoptable = (tab: T | undefined): T | undefined =>
    tab && unassociated.has(tab.id) && !claimed.has(tab.id) ? tab : undefined
  // An id names a tab of one host only: tabs saved before host stamping name no host.
  const adoptableById = (tab: T | undefined): T | undefined =>
    tab?.executionHostId === undefined || tab.executionHostId === hostId
      ? adoptable(tab)
      : undefined
  return {
    origin: (tabId) => ({ hostId, workspaceId, tabId }),
    resolve: (hostTabId, contentHolder, preferred) => {
      const known = resolved.get(hostTabId)
      if (known) {
        return known
      }
      const tab =
        byHostTab.get(hostTabId) ??
        adoptableById(unassociated.get(toWebTerminalSurfaceTabId(hostTabId))) ??
        adoptableById(unassociated.get(hostTabId)) ??
        adoptable(contentHolder)
      let id = tab?.id ?? preferred
      if (tab) {
        claimed.add(tab.id)
      } else {
        for (let suffix = 2; occupied.has(id); suffix++) {
          id = `${preferred}-${suffix}`
        }
        occupied.add(id)
      }
      const result = tab ? { id, tab } : { id }
      resolved.set(hostTabId, result)
      return result
    }
  }
}
