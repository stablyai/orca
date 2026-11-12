import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { ElectronApplication } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { prepareImagePasteFolder } from './helpers/explorer-image-paste'
import { installImagePasteClipboard } from './helpers/paired-image-paste-probes'
import {
  getActiveWorktreeContext,
  openMarkdownFixture,
  waitForRichMarkdownEditor
} from './helpers/markdown-editor-fixture'
import { ensureTerminalVisible } from './helpers/store'
import {
  focusActiveTerminalInput,
  sendToTerminal,
  waitForActivePaneHookDescriptor,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForTerminalOutput
} from './helpers/terminal'
import { installTerminalPtyWriteSpy, readTerminalPtyWrites } from './helpers/terminal-pty-write-spy'

async function dispatchMenuPaste(app: ElectronApplication) {
  await app.evaluate(({ BrowserWindow }) => {
    // Hidden windows have DOM focus; this is the event sent by Edit > Paste.
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('ui:appMenuPaste')
    }
  })
}

test('selected explorer folder does not intercept terminal image paste', async ({
  orcaPage: page,
  electronApp
}, testInfo) => {
  const { destination, folder } = await prepareImagePasteFolder(page, 'terminal-paste-owner')
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page)
  // Why: a paste sent while the pane is still attaching its shell is cancelled as a stale target.
  const ptyId = await waitForActivePanePtyId(page)
  await sendToTerminal(page, ptyId, `node -e "console.log('IMAGE_PASTE_' + 'READY')"\r`)
  await waitForTerminalOutput(page, 'IMAGE_PASTE_READY', 15_000)
  await installTerminalPtyWriteSpy(electronApp)
  const clipboard = await installImagePasteClipboard(electronApp)
  try {
    await folder.click()
    await expect(folder).toHaveAttribute('data-selected', 'true')
    await focusActiveTerminalInput(page)
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+v' : 'Control+v')
    await waitForTerminalOutput(page, 'orca-paste-', 10_000)
    await expect
      .poll(async () => (await readTerminalPtyWrites(electronApp)).join(''))
      .toMatch(/orca-paste-.*\.png/)
    const first = (await readTerminalPtyWrites(electronApp)).join('')
    expect(first.match(/orca-paste-/g)).toHaveLength(1)
    await dispatchMenuPaste(electronApp)
    await expect
      .poll(
        async () =>
          (await readTerminalPtyWrites(electronApp)).join('').match(/orca-paste-/g)?.length
      )
      .toBe(2)
    expect(await readdir(destination)).toEqual([])
    await expect(folder).toHaveAttribute('data-selected', 'true')
    await page.screenshot({ path: testInfo.outputPath('terminal-retains-image-paste.png') })
  } finally {
    await clipboard.evaluate((probe) => probe.restore())
    await clipboard.dispose()
  }
})

test('selected explorer folder does not intercept chat image paste', async ({
  orcaPage: page,
  electronApp
}, testInfo) => {
  const { destination, folder } = await prepareImagePasteFolder(page, 'chat-paste-owner')
  await ensureTerminalVisible(page)
  await waitForActiveTerminalManager(page)
  const descriptor = await waitForActivePaneHookDescriptor(page)
  await page.evaluate(async ({ paneKey, worktreeId }) => {
    const settings = await window.api.settings.set({ experimentalNativeChat: true })
    const store = window.__store!
    store.setState({ settings })
    const state = store.getState()
    state.setAgentStatus(
      paneKey,
      { state: 'done', agentType: 'omp', prompt: '' },
      'OMP',
      undefined,
      { worktreeId }
    )
    const [tabId] = paneKey.split(':')
    const tab = (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
      (candidate) => candidate.contentType === 'terminal' && candidate.entityId === tabId
    )
    if (!tab) {
      throw new Error('Terminal tab unavailable')
    }
    state.toggleTabViewMode(tab.id)
  }, descriptor)
  const composer = page.getByRole('textbox', {
    name: 'Ask anything, @ to mention files, / for commands',
    exact: true
  })
  await expect(composer).toBeVisible()
  const clipboard = await installImagePasteClipboard(electronApp)
  try {
    await folder.click()
    await composer.focus()
    await expect(composer).toBeFocused()
    await dispatchMenuPaste(electronApp)
    await expect(page.getByRole('button', { name: /^View image:/ })).toHaveCount(1)
    await expect(page.getByRole('button', { name: /^View image:/ })).toBeVisible()
    expect(await readdir(destination)).toEqual([])
    await expect(folder).toHaveAttribute('data-selected', 'true')
    await page.screenshot({ path: testInfo.outputPath('chat-retains-image-paste.png') })
  } finally {
    await clipboard.evaluate((probe) => probe.restore())
    await clipboard.dispose()
  }
})

test('selected explorer folder does not intercept editor image paste', async ({
  orcaPage: page,
  electronApp
}, testInfo) => {
  const { destination, folder } = await prepareImagePasteFolder(page, 'editor-paste-owner')
  const context = await getActiveWorktreeContext(page)
  const filePath = path.join(context.rootPath, 'paste-owner.md')
  await writeFile(filePath, 'Editor image paste\n')
  await openMarkdownFixture(page, context, filePath)
  const editor = await waitForRichMarkdownEditor(page)
  const clipboard = await installImagePasteClipboard(electronApp)
  try {
    const png = await clipboard.evaluate((probe) => probe.png)
    await folder.click()
    await editor.focus()
    await expect(editor).toBeFocused()
    await editor.evaluate((element, png) => {
      const data = new DataTransfer()
      data.items.add(
        new File(
          [Uint8Array.from(atob(png), (character) => character.charCodeAt(0))],
          'image.png',
          { type: 'image/png' }
        )
      )
      element.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data })
      )
    }, png)
    await expect(editor.locator('img')).toBeVisible()
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+s' : 'Control+s')
    await expect.poll(() => readFile(filePath, 'utf8')).toContain('![')
    expect(await readdir(destination)).toEqual([])
    await expect(folder).toHaveAttribute('data-selected', 'true')
    await page.screenshot({ path: testInfo.outputPath('editor-retains-image-paste.png') })
  } finally {
    await clipboard.evaluate((probe) => probe.restore())
    await clipboard.dispose()
  }
})
