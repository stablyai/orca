/**
 * Whole-partition census of the PTY ids a durable workspace session names.
 *
 * Why not `readDurablePaneBindings`: that one is scoped to a worktree, so it
 * can only see contamination that lands under a worktree the caller already
 * knows about. Journey 7 has to answer "does any id belonging to host A appear
 * anywhere under host B", which needs the whole partition.
 */
import type { Page } from '@stablyai/playwright-test'

type DurableSession = {
  tabsByWorktree?: Record<string, { id: string; ptyId?: string | null }[]>
  terminalLayoutsByTabId?: Record<string, { ptyIdsByLeafId?: Record<string, string> }>
  terminalPtyIncarnationsByPaneKey?: Record<string, string>
}

/** Every PTY id named anywhere in one durable partition, sorted. */
export async function readDurablePartitionPtyIds(
  page: Page,
  partition: string | null
): Promise<string[]> {
  return page.evaluate(async (partition) => {
    const session = (await window.api.session.get(partition ?? undefined)) as DurableSession | null
    if (!session) {
      return []
    }
    const tabPtyIds = Object.values(session.tabsByWorktree ?? {})
      .flat()
      .flatMap((tab) => (tab.ptyId ? [tab.ptyId] : []))
    const layoutPtyIds = Object.values(session.terminalLayoutsByTabId ?? {}).flatMap((layout) =>
      Object.values(layout.ptyIdsByLeafId ?? {})
    )
    return [...tabPtyIds, ...layoutPtyIds].sort()
  }, partition)
}
