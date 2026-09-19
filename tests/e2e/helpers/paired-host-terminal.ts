/** Shared plumbing for paired-desktop terminal specs: the headed host owns the terminal, the
 *  paired client mirrors it as a web-terminal surface tab. Extracted so more than one spec can
 *  drive the same topology without re-deriving the surface-id mapping. */
import type { Page } from '@stablyai/playwright-test'
import { expect } from '@stablyai/playwright-test'
import {
  HOST_TERMINAL_SURFACE_SEPARATOR,
  toWebTerminalSurfaceTabId
} from '../../../src/shared/terminal-surface-id'

export type PairedHostTerminal = {
  /** The host's own tab id, for host-side RPCs. */
  hostTabId: string
  /** The host terminal handle, for terminal.* RPCs such as closeTab. */
  terminal: string
  /** The id the paired client mirrors the host tab under. */
  webTabId: string
}

export async function callEnvironment(
  page: Page,
  environmentId: string,
  method: string,
  params: unknown
): Promise<unknown> {
  return page.evaluate(
    async ({ environmentId, method, params }) => {
      const response = await window.api.runtimeEnvironments.call({
        selector: environmentId,
        method,
        params
      })
      if (!response.ok) {
        throw new Error(`${response.error.code}: ${response.error.message}`)
      }
      return response.result
    },
    { environmentId, method, params }
  )
}

/** Validates rather than asserts: an RPC shape change should fail here with the shape named, not
 *  surface later as an undefined surface id. */
function readCreatedTerminalTab(result: unknown): { id: string; terminal: string } {
  if (
    typeof result === 'object' &&
    result !== null &&
    'tab' in result &&
    typeof result.tab === 'object' &&
    result.tab !== null &&
    'id' in result.tab &&
    typeof result.tab.id === 'string' &&
    'terminal' in result.tab &&
    typeof result.tab.terminal === 'string'
  ) {
    return { id: result.tab.id, terminal: result.tab.terminal }
  }
  throw new Error(`host session terminal was not created: ${JSON.stringify(result)}`)
}

export async function createPairedHostTerminal(
  page: Page,
  environmentId: string,
  worktreeId: string,
  command: string
): Promise<PairedHostTerminal> {
  const tab = readCreatedTerminalTab(
    await callEnvironment(page, environmentId, 'session.tabs.createTerminal', {
      worktree: `id:${worktreeId}`,
      command,
      activate: false,
      select: false,
      navigation: 'caller'
    })
  )
  // Why: the host answers with a `tabId::leafId` surface id; client tabs mirror the parent tab.
  const hostTabId = tab.id.split(HOST_TERMINAL_SURFACE_SEPARATOR)[0]
  return { hostTabId, terminal: tab.terminal, webTabId: toWebTerminalSurfaceTabId(hostTabId) }
}

export async function openPairedClientTab(
  page: Page,
  worktreeId: string,
  webTabId: string
): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(
          (id) => (window.__store?.getState().tabsByWorktree[id] ?? []).map((tab) => tab.id),
          worktreeId
        ),
      { timeout: 60_000, message: `client never mirrored host tab ${webTabId}` }
    )
    .toContain(webTabId)
  await page.evaluate(
    ({ webTabId, worktreeId }) => {
      const state = window.__store?.getState()
      state?.setActiveView('terminal')
      state?.setActiveWorktree(worktreeId)
      state?.setActiveTab(webTabId)
      state?.setActiveTabType('terminal')
    },
    { webTabId, worktreeId }
  )
  await expect
    .poll(() => page.evaluate((id) => window.__paneManagers?.has(id) ?? false, webTabId), {
      timeout: 60_000,
      message: `client pane for ${webTabId} did not mount`
    })
    .toBe(true)
}

/** Reads the target tab's own buffer. `getTerminalContent` resolves whatever tab the store thinks
 *  is active, which hides per-tab reveal failures. */
export async function readPairedPaneContent(page: Page, webTabId: string): Promise<string> {
  return page.evaluate((id) => {
    const manager = window.__paneManagers?.get(id)
    const pane = manager?.getActivePane?.() ?? manager?.getPanes?.()[0] ?? null
    return pane?.serializeAddon?.serialize?.() ?? ''
  }, webTabId)
}

export async function waitForPairedPaneMarker(
  page: Page,
  webTabId: string,
  marker: string,
  budgetMs: number
): Promise<boolean> {
  const deadline = Date.now() + budgetMs
  for (;;) {
    if ((await readPairedPaneContent(page, webTabId)).includes(marker)) {
      return true
    }
    if (Date.now() >= deadline) {
      return false
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
}
