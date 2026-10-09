/**
 * Readers for each place the workspace layout shows up: the runtime's own copy, what the window
 * draws (DOM), and what a paired client or the CLI is told (runtime RPC).
 */

import type { Page } from '@stablyai/playwright-test'
import type { RuntimeClient } from '../../../src/cli/runtime/client'
import {
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  type ExecutionHostId
} from '../../../src/shared/execution-host'
import type { RuntimeMobileSessionTabsResult } from '../../../src/shared/runtime-session-contracts'
import type { RuntimeTerminalListResult } from '../../../src/shared/runtime-terminal-contracts'
import type { WorkspaceSessionState } from '../../../src/shared/workspace-session-state-types'
import type { WorkspaceLayoutPartition } from './workspace-layout-oracle-model'

/** Main's in-memory session for every partition, through the read-only session IPC. */
export function readRuntimePartitions(page: Page): Promise<WorkspaceLayoutPartition[]> {
  return page.evaluate(async () => {
    const hostIds = await window.api.session.listHostIds()
    const ids: ExecutionHostId[] = hostIds.includes('local') ? hostIds : ['local', ...hostIds]
    const partitions: WorkspaceLayoutPartition[] = []
    for (const hostId of ids) {
      partitions.push({ hostId, session: await window.api.session.get(hostId) })
    }
    return partitions
  })
}

/** The saved profile's partitions, for a runtime with no window (or a stopped one). */
export function partitionsFromProfileRoot(root: {
  workspaceSession?: WorkspaceSessionState
  workspaceSessionsByHostId?: Partial<Record<ExecutionHostId, WorkspaceSessionState>>
}): WorkspaceLayoutPartition[] {
  const byHost: WorkspaceLayoutPartition[] = Object.entries(
    root.workspaceSessionsByHostId ?? {}
  ).flatMap(([id, session]) => {
    const hostId = normalizeExecutionHostId(id)
    return hostId && session ? [{ hostId, session }] : []
  })
  const local: WorkspaceLayoutPartition[] = root.workspaceSession
    ? [{ hostId: LOCAL_EXECUTION_HOST_ID, session: root.workspaceSession }]
    : []
  return [...local, ...byHost]
}

export type DrawnPane = { leafId: string; ptyId: string | null }
export type DrawnTerminalSurface = {
  tabId: string
  worktreeId: string | null
  visible: boolean
  panes: DrawnPane[]
}
export type DrawnStrip = { groupId: string; worktreeId: string; tabIds: string[] }
export type DrawnLayout = { strips: DrawnStrip[]; surfaces: DrawnTerminalSurface[] }

/** What the window draws, read from the DOM only. */
export function readDrawnLayout(page: Page): Promise<DrawnLayout> {
  return page.evaluate(() => {
    const strips = Array.from(
      document.querySelectorAll<HTMLElement>('[data-tab-group-strip-id][data-worktree-id]')
    ).map((strip) => ({
      groupId: strip.dataset.tabGroupStripId ?? '',
      worktreeId: strip.dataset.worktreeId ?? '',
      tabIds: Array.from(strip.querySelectorAll<HTMLElement>('[data-tab-id]')).map(
        (tab) => tab.dataset.tabId ?? ''
      )
    }))
    const surfaces = Array.from(
      document.querySelectorAll<HTMLElement>('[data-terminal-tab-id]')
    ).map((surface) => {
      const body = surface.closest<HTMLElement>('[data-tab-group-body-id][data-worktree-id]')
      const rect = surface.getBoundingClientRect()
      return {
        tabId: surface.dataset.terminalTabId ?? '',
        worktreeId: body?.dataset.worktreeId ?? null,
        visible:
          rect.width > 0 && rect.height > 0 && getComputedStyle(surface).visibility !== 'hidden',
        panes: Array.from(surface.querySelectorAll<HTMLElement>('.pane[data-leaf-id]')).map(
          (pane) => ({ leafId: pane.dataset.leafId ?? '', ptyId: pane.dataset.ptyId ?? null })
        )
      }
    })
    return { strips, surfaces }
  })
}

export type ClientView = {
  worktreeId: string
  tabs: RuntimeMobileSessionTabsResult | null
  terminals: RuntimeTerminalListResult['terminals']
  error?: string
}

/** What a paired client (session tabs) and the CLI (terminal list) are told for one worktree. */
export async function readClientView(
  client: RuntimeClient,
  worktreeId: string
): Promise<ClientView> {
  const worktree = `id:${worktreeId}`
  try {
    const [tabs, terminals] = await Promise.all([
      client.call<RuntimeMobileSessionTabsResult>('session.tabs.list', { worktree }),
      client.call<RuntimeTerminalListResult>('terminal.list', { worktree })
    ])
    return { worktreeId, tabs: tabs.result, terminals: terminals.result.terminals }
  } catch (error) {
    return { worktreeId, tabs: null, terminals: [], error: String(error) }
  }
}
