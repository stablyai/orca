import { expect, test } from './helpers/orca-app'
import { attachRepoAndOpenTerminal, createRestartSession } from './helpers/orca-restart'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'
import {
  focusActiveTerminalInput,
  getTerminalContent,
  waitForActivePanePtyId,
  waitForTerminalOutput
} from './helpers/terminal'
import { splitMarkerEchoCommand } from './terminal-marker-echo-command'
import type { ElectronApplication } from '@stablyai/playwright-test'

test.describe.configure({ mode: 'serial' })

// Why: the in-app herdr daemon (terminalBackendDefault === 'herdr') is the
// always-available backend with no external binary dependency, so it is the
// authoritative end-to-end gate for the herdr integration. Assertions target
// the DOM (tab bar, pane ptyId, xterm serialize addon), never the store.
test('herdr terminal opens, is visible, accepts input, and reattaches after restart', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(180_000)

  const session = createRestartSession(testInfo)
  let app: ElectronApplication | null = null
  const markerPrefix = 'HERDR-E2E'
  const markerSuffix = `${Date.now()}`
  const marker = `${markerPrefix}${markerSuffix}`
  const appLogs: string[] = []
  const captureLogs = () => (chunk: string) => appLogs.push(chunk)

  try {
    // ── First launch: open a herdr terminal through the real UI ─────────────
    const first = await session.launch({ onStderr: captureLogs() })
    app = first.app
    await waitForSessionReady(first.page)

    // Activate the in-app daemon fallback so this suite does not need a stock
    // herdr binary. Stock from PATH is the product path and is covered by the
    // pinned-binary integration tests.
    await first.page.evaluate(() => {
      window.__store?.getState().updateSettings({
        terminalBackendDefault: 'herdr',
        herdrRuntimeSource: 'daemon'
      })
    })

    await attachRepoAndOpenTerminal(first.page, testRepoPath)
    await ensureTerminalVisible(first.page)

    // Terminal tab is visible in the real tab bar.
    await expect(first.page.locator('[data-testid="sortable-tab"]')).toHaveCount(1)

    // The pane is bound through the in-app daemon: herdr ptyIds are prefixed.
    const ptyId = await waitForActivePanePtyId(first.page, 30_000).catch((error) => {
      throw new Error(`${String(error)}\nApp logs:\n${appLogs.join('\n')}`)
    })
    expect(ptyId.startsWith('herdr:')).toBe(true)

    // Real keyboard input through the focused xterm; the split marker only
    // rejoins in the shell's output, so a match proves the command ran.
    await focusActiveTerminalInput(first.page)
    await first.page.keyboard.type(splitMarkerEchoCommand(markerPrefix, markerSuffix))
    await first.page.keyboard.press('Enter')
    await waitForTerminalOutput(first.page, marker, 30_000).catch(async (error) => {
      throw new Error(
        `${String(error)}\nApp logs:\n${appLogs.join('\n')}\nTerminal:\n${await getTerminalContent(first.page)}`
      )
    })

    // ── Restart: the herdr terminal reattaches with its scrollback ──────────
    await session.close(app)
    app = null

    const second = await session.launch({ onStderr: captureLogs() })
    app = second.app
    await waitForSessionReady(second.page)
    await attachRepoAndOpenTerminal(second.page, testRepoPath)
    await ensureTerminalVisible(second.page)

    const restoredPtyId = await waitForActivePanePtyId(second.page, 30_000).catch((error) => {
      throw new Error(`${String(error)}\nApp logs:\n${appLogs.join('\n')}`)
    })
    expect(restoredPtyId.startsWith('herdr:')).toBe(true)
    // The echoed marker survived the restart in the replayed scrollback.
    await waitForTerminalOutput(second.page, marker, 30_000)
  } finally {
    if (app) {
      await session.close(app)
    }
    await session.dispose()
  }
})
