import { observeTranscriptPaneLifetime } from './helpers/native-chat-transcript-fixture'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  waitForActivePaneHookDescriptor,
  waitForActivePanePtyId,
  waitForActiveTerminalManager,
  waitForPaneIdentitySnapshot
} from './helpers/terminal'
import { waitForPtyShellEcho } from './terminal-pty-readiness'

const FIRST = 'Firstparagraph bravo charlie delta.'
const SECOND = 'Secondparagraph echo foxtrot golf.'
const PASTED = 'Clipboard text belongs in this composer.'

test('chat right-click offers Copy for selected text and Paste in the composer only', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const boundPane = await waitForPaneIdentitySnapshot(orcaPage, 1)
  const ptyId = await waitForActivePanePtyId(orcaPage)
  await waitForPtyShellEcho(orcaPage, ptyId, 15_000)
  const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
  expect(descriptor.paneKey).toBe(`${boundPane.tabId}:${boundPane.activeLeafId}`)
  const [tabId] = descriptor.paneKey.split(':')
  const sessionId = `e2e-context-menu-${randomUUID()}`
  const scratchDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-native-chat-menu-'))
  const transcriptPath = path.join(scratchDir, `${sessionId}.jsonl`)
  const row = (index: number, role: 'user' | 'assistant', text: string): string =>
    JSON.stringify({
      sessionId,
      uuid: `${sessionId}-${index}`,
      timestamp: new Date(Date.now() - (10 - index) * 1_000).toISOString(),
      type: role,
      message: { role, model: 'claude-opus-4', content: [{ type: 'text', text }] }
    })
  writeFileSync(
    transcriptPath,
    `${row(0, 'user', 'Question alpha')}\n${row(1, 'assistant', `${FIRST}\n\n${SECOND}`)}\n`
  )
  const finishLifetime = await observeTranscriptPaneLifetime(orcaPage, {
    tabId,
    worktreeId: descriptor.worktreeId,
    paneKey: descriptor.paneKey
  })
  const nativeMenu = await electronApp.evaluateHandle(({ Menu }) => {
    const originalBuild = Menu.buildFromTemplate
    const originalPopup = Menu.prototype.popup
    const menus: InstanceType<typeof Menu>[] = []
    let opened: InstanceType<typeof Menu> | null = null
    // Keep the real menu builder and callbacks; intercept only its OS popup.
    Menu.buildFromTemplate = (...args) => {
      const menu = originalBuild(...args)
      menus.push(menu)
      menu.popup = () => {
        opened = menu
      }
      return menu
    }
    return {
      items: () =>
        opened?.items.map((item) => ({ label: item.label, enabled: item.enabled })) ?? [],
      paste: () => {
        const item = opened?.items.find((candidate) => candidate.label === 'Paste')
        if (!item?.enabled) {
          throw new Error('The actual native composer menu has no enabled Paste command')
        }
        item.click()
      },
      restore: () => {
        Menu.buildFromTemplate = originalBuild
        for (const menu of menus) {
          menu.popup = originalPopup
        }
      }
    }
  })
  try {
    // Substitute only the clipboard IPC; never touch the user's system clipboard.
    await electronApp.evaluate(({ ipcMain }, pasteText) => {
      ipcMain.removeHandler('clipboard:writeText')
      ipcMain.handle('clipboard:writeText', (_event, text: string) => {
        process.env.ORCA_E2E_COPIED_TEXT = text
      })
      ipcMain.removeHandler('clipboard:readText')
      ipcMain.handle('clipboard:readText', () => pasteText)
      ipcMain.removeHandler('clipboard:readFilePaths')
      ipcMain.handle('clipboard:readFilePaths', () => [])
      ipcMain.removeHandler('clipboard:hasImage')
      ipcMain.handle('clipboard:hasImage', () => false)
    }, PASTED)
    const takeCopiedText = (): Promise<string | null> =>
      electronApp.evaluate(() => {
        const text = process.env.ORCA_E2E_COPIED_TEXT ?? null
        delete process.env.ORCA_E2E_COPIED_TEXT
        return text
      })
    await orcaPage.evaluate(
      async ({ paneKey, worktreeId, sessionId, transcriptPath, tabId }) => {
        const settings = await window.api.settings.set({
          nativeChatProviders: { claude: true, codex: true }
        })
        const store = window.__store
        if (!store) {
          throw new Error('Store unavailable')
        }
        store.setState({ settings })
        const state = store.getState()
        state.setAgentStatus(
          paneKey,
          { state: 'done', prompt: 'context menu proof', agentType: 'claude' },
          'Claude',
          undefined,
          { worktreeId },
          { providerSession: { key: 'session_id', id: sessionId, transcriptPath } }
        )
        const tab = (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
          (candidate) => candidate.contentType === 'terminal' && candidate.entityId === tabId
        )
        if (!tab) {
          throw new Error('Terminal tab unavailable')
        }
        state.toggleTabViewMode(tab.id)
      },
      { ...descriptor, sessionId, transcriptPath, tabId }
    )
    const first = orcaPage.getByText(FIRST)
    const second = orcaPage.getByText(SECOND)
    await expect(first).toBeVisible({ timeout: 30_000 })
    const menu = orcaPage.locator('[data-native-chat-context-menu]')
    const copy = menu.getByRole('menuitem', { name: /^Copy\s*(⌘C|Ctrl\+C)$/ })
    const paste = menu.getByRole('menuitem', { name: 'Paste', exact: true })

    // Nothing selected: neither edit action applies to a message.
    await second.click({ button: 'right' })
    await expect(menu).toBeVisible()
    await expect(copy).toHaveCount(0)
    await expect(paste).toHaveCount(0)
    expect(await nativeMenu.evaluate((menu) => menu.items())).toEqual([])

    // The press lands on the selection: a menu opened elsewhere drops it on purpose.
    await first.click({ clickCount: 3 })
    await first.click({ button: 'right' })
    await copy.click()
    await expect.poll(takeCopiedText).toContain(FIRST)
    await expect
      .poll(() => orcaPage.evaluate(() => window.getSelection()?.toString() ?? ''))
      .toContain(FIRST)

    if (process.platform === 'darwin') {
      await first.click({ clickCount: 3 })
      await first.click({ modifiers: ['Control'] })
      await copy.click()
      await expect.poll(takeCopiedText).toContain(FIRST)
    }

    const composer = orcaPage.locator('[data-native-chat-root="true"]').getByRole('textbox')
    await composer.click()
    await expect(composer).toBeFocused()
    await composer.click({ button: 'right' })
    await expect
      .poll(() => nativeMenu.evaluate((menu) => menu.items()))
      .toContainEqual({ label: 'Paste', enabled: true })
    await nativeMenu.evaluate((menu) => menu.paste())
    await expect(composer).toHaveText(PASTED)
    const finalPane = await waitForPaneIdentitySnapshot(orcaPage, 1)
    expect(finalPane.tabId).toBe(boundPane.tabId)
    expect(finalPane.activeLeafId).toBe(boundPane.activeLeafId)
    expect(finalPane.ptyIdsByLeafId).toEqual(boundPane.ptyIdsByLeafId)
    await expect(orcaPage.locator('[data-native-chat-root="true"]')).toBeVisible()
  } finally {
    await nativeMenu.evaluate((menu) => menu.restore())
    await nativeMenu.dispose()
    await testInfo.attach('transcript-pane-lifetime', {
      body: JSON.stringify(await finishLifetime()),
      contentType: 'application/json'
    })
    rmSync(scratchDir, { recursive: true, force: true })
  }
})
