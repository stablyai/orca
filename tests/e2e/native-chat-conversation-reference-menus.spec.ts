import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './helpers/terminal'
import { claudeTranscriptLines } from './helpers/native-chat-transcript-fixture'

test('real sidebar and history menus insert readable references without sending or resuming', async ({
  orcaPage,
  electronApp
}, testInfo) => {
  test.setTimeout(180_000)
  await waitForSessionReady(orcaPage)
  await electronApp.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.setSize(1440, 960)
    }
  })
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
  const [tabId] = descriptor.paneKey.split(':')
  const home = await electronApp.evaluate(({ app }) => app.getPath('home'))
  const sessionId = randomUUID()
  const sourceTitle = 'Reference menu source conversation'
  const sourceAnswer = 'The saved source answer is read from its real transcript file.'
  const directory = join(home, '.claude', 'projects', '-reference-menu-e2e')
  mkdirSync(directory, { recursive: true })
  const transcriptPath = join(directory, `${sessionId}.jsonl`)
  writeFileSync(
    transcriptPath,
    claudeTranscriptLines({ sessionId, userText: sourceTitle, assistantText: sourceAnswer })
  )
  await orcaPage.evaluate(
    async ({ paneKey, worktreeId, sessionId, transcriptPath, tabId, sourceTitle }) => {
      const settings = await window.api.settings.set({
        experimentalNativeChat: true,
        uiLanguage: 'en',
        theme: 'dark'
      })
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable')
      }
      store.setState({ settings, sidebarOpen: true, agentActivityDisplayMode: 'compact' })
      const state = store.getState()
      state.setAgentStatus(
        paneKey,
        { state: 'done', agentType: 'claude', prompt: sourceTitle },
        'Claude',
        undefined,
        { worktreeId },
        { providerSession: { key: 'session_id', id: sessionId, transcriptPath } }
      )
      const tab = state.unifiedTabsByWorktree[worktreeId]?.find(
        (candidate) => candidate.contentType === 'terminal' && candidate.entityId === tabId
      )
      if (!tab) {
        throw new Error('Terminal unavailable')
      }
      state.toggleTabViewMode(tab.id)
      await window.api.aiVault.listSessions({ executionHostScope: 'local', force: true })
    },
    { ...descriptor, sessionId, transcriptPath, tabId, sourceTitle }
  )
  const root = orcaPage.locator('[data-native-chat-root="true"]')
  await expect(root.getByText(sourceAnswer, { exact: true })).toBeVisible()
  const input = root.getByRole('textbox').last()
  await input.fill('Keep my existing draft. ')
  const cdp = await orcaPage.context().newCDPSession(orcaPage)
  const capture = async (name: string, menuOpen = false): Promise<void> => {
    if (menuOpen) {
      await expect(orcaPage.getByRole('menu')).toHaveCSS('opacity', '1')
    }
    await orcaPage.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    )
    const screenshot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true
    })
    const path = testInfo.outputPath(`${name}.png`)
    writeFileSync(path, Buffer.from(screenshot.data, 'base64'))
    await testInfo.attach(name, { path, contentType: 'image/png' })
  }
  const initialTabs = await orcaPage.evaluate(
    () => Object.values(window.__store?.getState().unifiedTabsByWorktree ?? {}).flat().length
  )
  const sidebarRow = orcaPage.locator('.compact-agent-row').filter({ hasText: sourceTitle }).first()
  if (!(await sidebarRow.isVisible())) {
    await orcaPage.locator('.compact-agent-summary-button[aria-expanded="false"]').first().click()
  }
  await sidebarRow.click({ button: 'right' })
  await expect(
    orcaPage.getByRole('menuitem', { name: 'Delete Worktree', exact: true })
  ).toHaveCount(0)
  await capture('01-left-reference-menu', true)
  await orcaPage.getByRole('menuitem', { name: 'Reference conversation', exact: true }).click()
  const pills = root.locator('[data-native-chat-conversation-reference]')
  await expect(pills).toHaveCount(1)
  await expect(input).toContainText('Keep my existing draft.')
  await capture('02-left-reference-inserted')
  await pills.first().click()
  await expect(orcaPage.getByRole('dialog')).toContainText(sourceAnswer)
  await capture('03-left-reference-preview')
  await orcaPage.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click()

  await orcaPage.evaluate(() => window.__store?.getState().showAiVaultSearch())
  await orcaPage.getByRole('radio', { name: 'All', exact: true }).click()
  await orcaPage.getByRole('textbox', { name: 'Search sessions', exact: true }).fill(sourceTitle)
  const historyRow = orcaPage
    .locator('[class~="group/session-row"]')
    .filter({ hasText: sourceTitle })
    .first()
  await expect(historyRow).toBeVisible({ timeout: 30_000 })
  await historyRow.click({ button: 'right' })
  await expect(
    orcaPage.getByRole('menuitem', { name: 'Copy conversation reference', exact: true })
  ).toBeVisible()
  await capture('04-right-reference-menu', true)
  await orcaPage.getByRole('menuitem', { name: 'Reference conversation', exact: true }).click()
  await expect(pills).toHaveCount(2)
  await capture('05-right-reference-inserted')
  await historyRow.getByTestId('ai-vault-session-more-actions').click()
  await capture('06-right-overflow-reference-menu', true)
  await orcaPage.getByRole('menuitem', { name: 'Reference conversation', exact: true }).click()
  await expect(pills).toHaveCount(3)
  await historyRow.getByText(sourceTitle, { exact: true }).dragTo(input, {
    sourcePosition: { x: 12, y: 8 }
  })
  await expect(pills).toHaveCount(4)
  await expect(input).toContainText('Keep my existing draft.')
  expect(
    await orcaPage.evaluate(
      () => Object.values(window.__store?.getState().unifiedTabsByWorktree ?? {}).flat().length
    )
  ).toBe(initialTabs)
  await capture('07-right-drag-reference-inserted')
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused())
    )
  ).toBe(true)
})
