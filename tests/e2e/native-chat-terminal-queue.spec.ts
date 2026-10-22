import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { getTerminalContent, waitForActivePaneHookDescriptor } from './helpers/terminal'
import {
  configureGoldenStubAgent,
  getGoldenStubAgentLaunchEnv,
  launchGoldenStubAgentFromNewTab
} from './helpers/golden-stub-agent'
import {
  claudeTranscriptLines,
  enableNativeChatSetting,
  seedClaudeProviderSession,
  toggleTerminalTabToChatView
} from './helpers/native-chat-transcript-fixture'

test.use({ launchEnv: getGoldenStubAgentLaunchEnv() })

async function persistedQueue(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      new Promise<string>((resolve, reject) => {
        const open = indexedDB.open('orca-native-chat-terminal-queued-drafts')
        open.onerror = () => reject(open.error)
        open.onsuccess = () => {
          const db = open.result
          const transaction = db.transaction('drafts', 'readonly')
          const read = transaction.objectStore('drafts').getAll()
          read.onsuccess = () => resolve(JSON.stringify(read.result))
          read.onerror = () => reject(read.error)
          transaction.oncomplete = () => db.close()
        }
      })
  )
}

test('queues, edits, and deletes a follow-up while the terminal agent is working', async ({
  orcaPage,
  electronApp,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await configureGoldenStubAgent(orcaPage, { agent: 'claude' })
  await launchGoldenStubAgentFromNewTab(orcaPage, /^Claude(?:\s|$)/i)
  const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
  const [tabId] = descriptor.paneKey.split(':')
  const sessionId = randomUUID()
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-terminal-queue-'))
  const transcriptPath = path.join(scratch, `${sessionId}.jsonl`)
  const history = claudeTranscriptLines({
    sessionId,
    userText: 'An earlier request.',
    assistantText: 'An earlier answer.'
  })
  // The saved answer predates the live working turn whose follow-up is being queued.
  const historicalLines = history
    .trim()
    .split('\n')
    .map((line) =>
      JSON.stringify({
        ...JSON.parse(line),
        timestamp: new Date(Date.now() - 60_000).toISOString()
      })
    )
  writeFileSync(transcriptPath, `${historicalLines.join('\n')}\n`)
  registerPostElectronShutdownCleanup(() => rm(scratch, { recursive: true, force: true }))
  await enableNativeChatSetting(orcaPage)
  await orcaPage.evaluate(async () => {
    await window.__store!.getState().updateSettings({ nativeChatQueueFollowUps: true })
  })
  await seedClaudeProviderSession(orcaPage, { ...descriptor, sessionId, transcriptPath })
  await toggleTerminalTabToChatView(orcaPage, { tabId, worktreeId: descriptor.worktreeId })

  const chat = orcaPage.locator('[data-native-chat-root="true"]')
  await expect(chat.getByText('An earlier answer.', { exact: true })).toBeVisible()
  await expect(chat.getByRole('button', { name: 'Stop the agent', exact: true })).toBeVisible()
  const composer = chat.getByRole('textbox')
  const original = 'Please review the follow-up after this turn.'
  const edited = 'Please review the updated follow-up after this turn.'
  await composer.fill(original)
  await composer.press('Enter')

  const queue = chat.getByRole('list', { name: 'Queued messages', exact: true })
  await expect(queue.getByText(original, { exact: true })).toBeVisible()
  await expect(composer).toHaveText('')
  await expect.poll(() => persistedQueue(orcaPage)).toContain(original)
  expect(await getTerminalContent(orcaPage)).not.toContain(original)
  expect(await getTerminalContent(orcaPage)).not.toContain('GOLDEN_STUB_AGENT_SUBMITTED')

  await queue.getByRole('button', { name: 'More actions', exact: true }).click()
  await orcaPage.getByRole('menuitem', { name: 'Edit message', exact: true }).click()
  await queue.getByRole('textbox', { name: 'Edit message', exact: true }).fill(edited)
  await queue.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(queue.getByText(edited, { exact: true })).toBeVisible()
  await expect.poll(() => persistedQueue(orcaPage)).toContain(edited)
  await expect.poll(() => persistedQueue(orcaPage)).not.toContain(original)
  await chat.screenshot({ path: testInfo.outputPath('terminal-queue-edited.png') })

  await queue.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(queue).toHaveCount(0)
  await expect.poll(() => persistedQueue(orcaPage)).not.toContain(edited)
  expect(await getTerminalContent(orcaPage)).not.toContain('GOLDEN_STUB_AGENT_SUBMITTED')
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused())
    )
  ).toBe(true)
})
