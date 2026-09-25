import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './helpers/terminal'

test('shows a Claude terminal suggestion and accepts it without sending', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
  const [tabId] = descriptor.paneKey.split(':')
  const sessionId = randomUUID()
  const transcriptPath = testInfo.outputPath(`${sessionId}.jsonl`)
  writeFileSync(
    transcriptPath,
    `${JSON.stringify({
      sessionId,
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Want me to write tests for both add and subtract next?' }]
      }
    })}\n`
  )
  await orcaPage.evaluate(
    async ({ descriptor, tabId, sessionId, transcriptPath }) => {
      const settings = await window.api.settings.set({ experimentalNativeChat: true })
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable')
      }
      store.setState({ settings })
      const state = store.getState()
      state.setAgentStatus(
        descriptor.paneKey,
        { state: 'done', agentType: 'claude', prompt: 'Suggestion preview' },
        'Claude',
        undefined,
        { worktreeId: descriptor.worktreeId },
        { providerSession: { key: 'session_id', id: sessionId, transcriptPath } }
      )
      const tab = state.unifiedTabsByWorktree[descriptor.worktreeId]?.find(
        (entry) => entry.contentType === 'terminal' && entry.entityId === tabId
      )
      if (!tab) {
        throw new Error('Terminal tab unavailable')
      }
      state.toggleTabViewMode(tab.id)
    },
    { descriptor, tabId, sessionId, transcriptPath }
  )
  const composer = orcaPage.locator('[data-native-chat-root] [role="textbox"]')
  await expect(composer).toBeVisible({ timeout: 30_000 })
  await expect(composer).toBeEditable()
  await orcaPage.screenshot({ path: testInfo.outputPath('before.png'), animations: 'disabled' })
  const capture = readFileSync(
    path.join(process.cwd(), 'src/main/runtime/__fixtures__/claude-prompt-suggestion.txt'),
    'utf8'
  )
  await orcaPage.evaluate(
    async ({ tabId, capture }) => {
      const pane = window.__paneManagers?.get(tabId)?.getActivePane()
      if (!pane) {
        throw new Error('Terminal pane unavailable')
      }
      pane.terminal.reset()
      pane.terminal.resize(100, 30)
      await new Promise<void>((resolve) => pane.terminal.write(capture, resolve))
      pane.terminal.scrollToBottom()
      // Replay a fixed captured screen; the fixture shell cannot redraw Claude after a fit.
      pane.terminal.resize = () => {}
      pane.terminal.write = (_data, callback) => callback?.()
      window.api.pty.write = (_id, data) => {
        document.body.dataset.suggestionTestPtyWrite = data
      }
    },
    { tabId, capture }
  )
  await expect(
    orcaPage.getByRole('status').filter({ hasText: 'yes, write tests for both' })
  ).toBeVisible()
  await expect(composer).toHaveText('')
  await orcaPage.screenshot({ path: testInfo.outputPath('after.png'), animations: 'disabled' })
  await composer.press('Tab')
  await expect(composer).toHaveText('yes, write tests for both')
  await expect(orcaPage.getByRole('button', { name: 'Use suggested prompt' })).toHaveCount(0)
  await expect(orcaPage.locator('[data-native-chat-root]')).toHaveAttribute(
    'data-native-chat-working',
    'false'
  )
  await orcaPage.screenshot({ path: testInfo.outputPath('accepted.png'), animations: 'disabled' })
  expect(
    await orcaPage.evaluate(() => document.body.dataset.suggestionTestPtyWrite)
  ).toBeUndefined()
  expect(
    await orcaPage.evaluate(
      (tabId) => window.__paneManagers?.get(tabId)?.getActivePane()?.terminal.buffer.active.cursorX,
      tabId
    )
  ).toBe(2)
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().some((window) => window.isVisible())
    )
  ).toBe(false)
})
