import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { expect, test } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { execInTerminal, waitForTerminalOutput } from './helpers/terminal'
import { assertLayerImagePixels, prepareLayerImage } from './helpers/terminal-inline-image-layers'
import {
  assertInlineImagePixels,
  assertKittyPlaceholderPixels,
  inlineImageProducer
} from './helpers/terminal-inline-image-proof'
import { nodeTerminalCommand } from './terminal-node-command'

for (const acceleration of ['off', 'on'] as const) {
  for (const z of [-1, -1499999999]) {
    test(`${acceleration}, z=${z}: inline images render in a folder workspace`, async ({
      orcaPage
    }, testInfo) => {
      await waitForSessionReady(orcaPage)
      const folder = testInfo.outputPath('workspace')
      mkdirSync(folder, { recursive: true })
      const folderPath = realpathSync(folder)
      await orcaPage.evaluate(async (path) => {
        const group = await window.api.projectGroups.create({
          name: 'Inline image folder proof',
          parentPath: path
        })
        const workspace = await window.api.folderWorkspaces.create({
          projectGroupId: group.id,
          name: 'Inline image folder proof',
          folderPath: path
        })
        const store = window.__store!
        await store.getState().fetchProjectGroups()
        await store.getState().fetchFolderWorkspaces()
        store.getState().setActiveFolderWorkspace(workspace.id)
      }, folderPath)

      const ptyId = await prepareLayerImage(orcaPage, testInfo, acceleration, z, 255)
      await assertLayerImagePixels(orcaPage, testInfo.outputPath('folder-layers.png'), z, 255)
      const producer = testInfo.outputPath('folder-protocols.cjs')
      writeFileSync(
        producer,
        `if (process.cwd() !== ${JSON.stringify(folderPath)}) throw new Error('Wrong folder PTY');\n${inlineImageProducer(true)}`
      )
      await execInTerminal(orcaPage, ptyId, nodeTerminalCommand([producer, 'FOLDER']))
      await waitForTerminalOutput(orcaPage, 'IMAGE_PROOF_FOLDER', 30_000)
      await assertInlineImagePixels(orcaPage, testInfo.outputPath('folder-protocols.png'))
      await assertKittyPlaceholderPixels(orcaPage, testInfo.outputPath('folder-placeholders.png'))
      await expect(orcaPage.locator('.pane:visible .xterm-screen').first()).toBeVisible()
    })
  }
}
