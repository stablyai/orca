import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './helpers/terminal'

const FIRST = 'Firstparagraph bravo charlie delta.'
const SECOND = 'Secondparagraph echo foxtrot golf.'

test('chat right-click offers Copy for selected text and Paste in the composer only', async ({
  orcaPage,
  electronApp
}) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
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
  try {
    // Substitute only the clipboard IPC; never touch the user's system clipboard.
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('clipboard:writeText')
      ipcMain.handle('clipboard:writeText', (_event, text: string) => {
        process.env.ORCA_E2E_COPIED_TEXT = text
      })
    })
    const takeCopiedText = (): Promise<string | null> =>
      electronApp.evaluate(() => {
        const text = process.env.ORCA_E2E_COPIED_TEXT ?? null
        delete process.env.ORCA_E2E_COPIED_TEXT
        return text
      })
    await orcaPage.evaluate(
      async ({ paneKey, worktreeId, sessionId, transcriptPath, tabId }) => {
        const settings = await window.api.settings.set({ experimentalNativeChat: true })
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

    // Why outside the selection: that press is what collapses it in Chromium when left alone.
    await first.click({ clickCount: 3 })
    await second.click({ button: 'right' })
    await copy.click()
    await expect.poll(takeCopiedText).toContain(FIRST)
    await expect
      .poll(() => orcaPage.evaluate(() => window.getSelection()?.toString() ?? ''))
      .toContain(FIRST)

    if (process.platform === 'darwin') {
      await first.click({ clickCount: 3 })
      await second.click({ modifiers: ['Control'] })
      await copy.click()
      await expect.poll(takeCopiedText).toContain(FIRST)
    }

    await orcaPage.locator('[data-native-chat-root="true"]').getByRole('textbox').click({
      button: 'right'
    })
    await expect(paste).toBeVisible()
  } finally {
    rmSync(scratchDir, { recursive: true, force: true })
  }
})
