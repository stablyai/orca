import { expect } from '@stablyai/playwright-test'
import type { Page } from '@stablyai/playwright-test'
import { execInTerminal } from './terminal'

export type LeafPaneState = { ptyId: string | null; mountedLeafIds: string[] }

/** The mounted pane of `leafId` inside tab `tabId`, read from its PaneManager. */
export async function readLeafPane(
  page: Page,
  tabId: string,
  leafId: string
): Promise<LeafPaneState> {
  return page.evaluate(
    ({ tabId, leafId }) => {
      const panes = window.__paneManagers?.get(tabId)?.getPanes() ?? []
      return {
        ptyId: panes.find((pane) => pane.leafId === leafId)?.container.dataset.ptyId ?? null,
        mountedLeafIds: panes.map((pane) => pane.leafId)
      }
    },
    { tabId, leafId }
  )
}

export async function readLeafPaneText(page: Page, tabId: string, leafId: string): Promise<string> {
  return page.evaluate(
    ({ tabId, leafId }) => {
      const pane = window.__paneManagers
        ?.get(tabId)
        ?.getPanes()
        .find((p) => p.leafId === leafId)
      return pane?.serializeAddon?.serialize?.() ?? ''
    },
    { tabId, leafId }
  )
}

/**
 * The pid of the shell behind a pane, printed by the shell itself. The echoed command line holds
 * the marker and the pid as separate fragments, so only the command's output matches.
 */
export async function readLeafShellPid(
  page: Page,
  args: { tabId: string; leafId: string; ptyId: string; label: string }
): Promise<number> {
  const marker = `PIDMARK_${args.label}_`
  await execInTerminal(page, args.ptyId, `echo "${marker}""$$"`)
  const pattern = new RegExp(`${marker}(\\d+)`)
  let pid = 0
  await expect
    .poll(
      async () => {
        const text = await readLeafPaneText(page, args.tabId, args.leafId)
        pid = Number(pattern.exec(text)?.[1] ?? 0)
        return pid
      },
      { timeout: 20_000, message: `Pane ${args.leafId} never printed ${marker}<pid>` }
    )
    .toBeGreaterThan(0)
  return pid
}
