import { readFileSync } from 'node:fs'
import { PNG } from 'pngjs'
import { resolveClaudeCommand } from '../../src/shared/node-cli-command-resolution'
import { createClaudePluginImageFixture } from './helpers/claude-plugin-image-fixture'
import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'
import { execInTerminal, sendToTerminal, waitForActiveTerminalManager } from './helpers/terminal'
import { enableInlineImages } from './helpers/terminal-inline-image-proof'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../src/shared/constants'
import { nodeTerminalCommand } from './terminal-node-command'

const enabled = process.env.ORCA_REAL_CLAUDE_PLUGIN_TEST === '1'
const command = process.env.ORCA_REAL_CLAUDE_COMMAND || resolveClaudeCommand()

test.use({
  launchEnv: { ORCA_BACKGROUND_LAUNCH: '1' },
  orcaAppExtraArgs: ['--force-color-profile=srgb']
})
test.skip(!enabled, 'Set ORCA_REAL_CLAUDE_PLUGIN_TEST=1 to run the installed Claude UI')

for (const acceleration of ['off', 'on'] as const) {
  for (const surface of ['bare', 'workspace', 'floating'] as const) {
    const managed = surface !== 'bare'
    const floating = surface === 'floating'
    test(`@headful ${acceleration}: real Claude plugin ${managed ? `${surface} managed launch renders bytes and host files` : 'reports unsupported automatic detection'}`, async ({
      orcaPage
    }, testInfo) => {
      await waitForSessionReady(orcaPage)
      await ensureTerminalVisible(orcaPage)
      await orcaPage.evaluate(async (policy) => {
        await window.__store!.getState().updateSettings({ terminalGpuAcceleration: policy })
      }, acceleration)
      await waitForActiveTerminalManager(orcaPage)
      await enableInlineImages(orcaPage)
      const { launcher, gateReceipt, cleanup } = createClaudePluginImageFixture(
        testInfo.outputPath('claude'),
        command,
        managed ? 'managed' : false
      )
      let tabId = await orcaPage.evaluate(() => window.__store!.getState().activeTabId)
      if (managed) {
        tabId = await orcaPage.evaluate(
          ({ startupCommand, floatingWorktreeId }) => {
            const store = window.__store!
            const state = store.getState()
            const worktreeId = floatingWorktreeId ?? state.activeWorktreeId
            if (!worktreeId) {
              throw new Error('Missing managed Claude workspace')
            }
            const tab = state.createTab(worktreeId, undefined, undefined, {
              launchAgent: 'claude',
              pendingStartup: { command: startupCommand, launchAgent: 'claude' }
            })
            state.activateTab(tab.id)
            return tab.id
          },
          {
            startupCommand: nodeTerminalCommand([launcher]),
            floatingWorktreeId: floating ? FLOATING_TERMINAL_WORKTREE_ID : null
          }
        )
      }
      if (floating) {
        await orcaPage.evaluate(async () => {
          await window.__store!.getState().updateSettings({ floatingTerminalEnabled: true })
        })
        await expect(orcaPage.locator('[data-floating-terminal-panel]')).toBeAttached()
        await orcaPage.evaluate(() =>
          window.dispatchEvent(new Event('orca-toggle-floating-terminal'))
        )
        await expect(orcaPage.locator('[data-floating-terminal-panel]')).toBeVisible()
      }
      await expect
        .poll(() =>
          orcaPage.evaluate(
            (id) => id && window.__paneManagers?.get(id)?.getActivePane()?.container.dataset.ptyId,
            tabId
          )
        )
        .toBeTruthy()
      const ptyId = await orcaPage.evaluate(
        (id) => id && window.__paneManagers?.get(id)?.getActivePane()?.container.dataset.ptyId,
        tabId
      )
      if (!ptyId) {
        throw new Error('Missing Claude test terminal')
      }
      const waitForOutput = async (text: string, timeout = 15_000) => {
        await expect
          .poll(
            () =>
              orcaPage.evaluate((id) => {
                const manager = id ? window.__paneManagers?.get(id) : undefined
                const pane = manager?.getActivePane()
                return pane?.serializeAddon?.serialize() ?? ''
              }, tabId),
            { timeout }
          )
          .toContain(text)
      }
      try {
        if (!managed) {
          await execInTerminal(orcaPage, ptyId, nodeTerminalCommand([launcher]))
        }
        await expect
          .poll(() =>
            orcaPage.evaluate((tabId) => {
              const manager = tabId && window.__paneManagers?.get(tabId)
              const pane = manager && manager.getActivePane()
              return Boolean(manager && pane && manager.hasWebglRenderer(pane.id))
            }, tabId)
          )
          .toBe(acceleration === 'on')
        await waitForOutput('IMAGE_ACCEPTANCE_bytes', 30_000)
        expect(JSON.parse(readFileSync(gateReceipt, 'utf8'))).toEqual({
          flag: managed ? '1' : null
        })
        const screen = orcaPage
          .locator(
            floating
              ? '[data-floating-terminal-panel] .pane:visible .xterm-screen'
              : '.pane:visible .xterm-screen'
          )
          .first()
        const colors = async (name: string) => {
          const notice = orcaPage.getByRole('status', {
            name: 'Usage display is now compact',
            exact: true
          })
          if (await notice.isVisible()) {
            await notice.getByRole('button', { name: 'Got it', exact: true }).click()
          }
          const png = PNG.sync.read(await screen.screenshot({ path: testInfo.outputPath(name) }))
          const counts = { red: 0, blue: 0, green: 0, yellow: 0 }
          for (let i = 0; i < png.data.length; i += 4) {
            const [r, g, b] = png.data.subarray(i, i + 3)
            if (r > 220 && g < 60 && b < 60) {
              counts.red++
            }
            if (r < 60 && g > 60 && g < 100 && b > 220) {
              counts.blue++
            }
            if (r < 60 && g > 220 && b < 60) {
              counts.green++
            }
            if (r > 220 && g > 180 && g < 220 && b < 60) {
              counts.yellow++
            }
          }
          return counts
        }
        if (!managed) {
          await waitForOutput('SYNTHETIC_IMAGE_FALLBACK')
          expect(await colors('automatic-fallback.png')).toEqual({
            red: 0,
            blue: 0,
            green: 0,
            yellow: 0
          })
          return
        }
        await expect
          .poll(
            async () => {
              const count = await colors('direct-bytes.png')
              return count.red > 1000 && count.blue > 1000
            },
            { timeout: 15_000 }
          )
          .toBe(true)
        await sendToTerminal(orcaPage, ptyId, '/image-acceptance file\r')
        await waitForOutput('IMAGE_ACCEPTANCE_STAGE_file')
        await expect
          .poll(
            async () => {
              const count = await colors('host-file.png')
              return count.green > 1000 && count.yellow > 1000 && count.red < 50 && count.blue < 50
            },
            { timeout: 15_000 }
          )
          .toBe(true)
        await sendToTerminal(orcaPage, ptyId, '/image-acceptance clear\r')
        await waitForOutput('IMAGE_ACCEPTANCE_STAGE_clear')
        await expect
          .poll(() => colors('cleared.png'), { timeout: 15_000 })
          .toEqual({ red: 0, blue: 0, green: 0, yellow: 0 })
      } finally {
        try {
          await orcaPage.evaluate((id) => window.api.pty.kill(id), ptyId)
        } finally {
          cleanup()
        }
      }
    })
  }
}
