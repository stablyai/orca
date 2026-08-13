/**
 * Durable (main-process) view of an SSH host's terminal panes.
 *
 * Why durable and not the renderer store: a reconnect binds PTYs in main. A
 * pane grafted there is invisible to the running renderer and only surfaces on
 * the next hydration — so the renderer census cannot see the defect at all.
 */
import type { Page } from '@stablyai/playwright-test'

/** `partition tabId/leafId=ptyId` for every pane a durable session names, sorted. */
export type DurablePaneBindings = string[]

/** Why both partitions: the renderer persists a remote worktree's panes to the
 *  host partition, while the reconnect binding path writes the local one. A
 *  census of either alone cannot see a pane grafted into the other. */
const LOCAL_PARTITION = 'local'

type DurableSession = {
  tabsByWorktree?: Record<string, { id: string }[]>
  terminalLayoutsByTabId?: Record<
    string,
    {
      root: unknown
      activeLeafId: string | null
      expandedLeafId: string | null
      ptyIdsByLeafId?: Record<string, string>
    }
  >
  terminalPtyIncarnationsByPaneKey?: Record<string, string>
}

export function sshExecutionHostId(targetId: string): string {
  return `ssh:${encodeURIComponent(targetId)}`
}

export async function readDurablePaneBindings(
  page: Page,
  hostId: string,
  worktreeId: string
): Promise<DurablePaneBindings> {
  return page.evaluate(
    async ({ hostId, worktreeId, localPartition }) => {
      const readPartition = async (partition: string): Promise<string[]> => {
        const session = (await window.api.session.get(
          partition === localPartition ? undefined : partition
        )) as DurableSession | null
        const tabs = session?.tabsByWorktree?.[worktreeId] ?? []
        return tabs.flatMap((tab) =>
          Object.entries(session?.terminalLayoutsByTabId?.[tab.id]?.ptyIdsByLeafId ?? {}).map(
            ([leafId, ptyId]) => `${partition} ${tab.id}/${leafId}=${ptyId}`
          )
        )
      }
      return [...(await readPartition(localPartition)), ...(await readPartition(hostId))].sort()
    },
    { hostId, worktreeId, localPartition: LOCAL_PARTITION }
  )
}
