import { expect, test } from './helpers/orca-app'
import { ensureTerminalVisible, waitForSessionReady } from './helpers/store'
import {
  execInTerminal,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import {
  assertInlineImagePixels,
  assertKittyPlaceholderPixels,
  enableInlineImages,
  inlineImagePayload
} from './helpers/terminal-inline-image-proof'
import { prepareInlineImageRuntime } from './helpers/terminal-inline-image-runtime'
import { nodeTerminalCommand } from './terminal-node-command'

test.skip(process.platform !== 'win32', 'Native Windows and WSL PTY coverage')

for (const runtime of ['native', 'wsl'] as const) {
  for (const acceleration of ['off', 'on'] as const) {
    test(`${runtime}, ${acceleration}: PTY images and Kitty placeholders render on Windows`, async ({
      orcaPage
    }, testInfo) => {
      await waitForSessionReady(orcaPage)
      await ensureTerminalVisible(orcaPage)
      await orcaPage.evaluate(async (policy) => {
        await window.__store!.getState().updateSettings({ terminalGpuAcceleration: policy })
      }, acceleration)
      await prepareInlineImageRuntime(orcaPage, runtime)
      await waitForActiveTerminalManager(orcaPage, 30_000)
      await enableInlineImages(orcaPage)
      await expect
        .poll(() =>
          orcaPage.evaluate(() => {
            const tab = window.__store!.getState().activeTabId
            const manager = tab && window.__paneManagers?.get(tab)
            const pane = manager && manager.getActivePane()
            return Boolean(manager && pane && manager.hasWebglRenderer(pane.id))
          })
        )
        .toBe(acceleration === 'on')
      const ptyId = await waitForActivePanePtyId(orcaPage)
      const marker = 'WINDOWS_INLINE_IMAGES_DONE'
      const payload = Buffer.from(`${inlineImagePayload(true)}${marker}\r\n`).toString('base64')
      const command =
        runtime === 'wsl'
          ? `printf '%s' '${payload}' | base64 -d; printf 'WSL_IMAGE_PROTOCOL=%s\\n' "$ORCA_IMAGE_PROTOCOL"`
          : nodeTerminalCommand(['-e', `process.stdout.write(Buffer.from('${payload}', 'base64'))`])
      await execInTerminal(orcaPage, ptyId, command)
      await waitForTerminalOutput(orcaPage, marker, 30_000)
      if (runtime === 'wsl') {
        await waitForTerminalOutput(orcaPage, 'WSL_IMAGE_PROTOCOL=kitty', 30_000)
      }
      await assertInlineImagePixels(orcaPage, testInfo.outputPath('windows-inline-protocols.png'))
      await assertKittyPlaceholderPixels(
        orcaPage,
        testInfo.outputPath('windows-inline-placeholders.png')
      )
    })
  }
}
