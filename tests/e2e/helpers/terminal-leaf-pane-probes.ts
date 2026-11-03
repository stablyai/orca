import { expect } from '@stablyai/playwright-test'
import type { Page } from '@stablyai/playwright-test'
import type { AgentStartupShell } from '../../../src/shared/tui-agent-startup-shell'
import { resolveWindowsShellStartupFamily } from '../../../src/shared/windows-terminal-shell'
import { shellPidEchoCommand } from './shell-pid-echo-command'
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

/** The shell a pane runs: POSIX off Windows; on Windows, the shell the pane's process reports. */
async function readPaneShell(page: Page, ptyId: string): Promise<AgentStartupShell> {
  if (process.platform !== 'win32') {
    return 'posix'
  }
  let shell = ''
  await expect
    .poll(
      async () => {
        shell =
          (await page.evaluate((id) => window.api.pty.inspectProcess(id), ptyId))
            .foregroundProcess ?? ''
        return shell
      },
      { timeout: 20_000, message: `PTY ${ptyId} never reported its shell` }
    )
    .not.toBe('')
  return resolveWindowsShellStartupFamily(shell)
}

/** The pid of the shell behind a pane, printed by the shell itself. */
export async function readLeafShellPid(
  page: Page,
  args: { tabId: string; leafId: string; ptyId: string; label: string }
): Promise<number> {
  const marker = `PIDMARK_${args.label}_`
  const shell = await readPaneShell(page, args.ptyId)
  await execInTerminal(page, args.ptyId, shellPidEchoCommand(marker, shell))
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
