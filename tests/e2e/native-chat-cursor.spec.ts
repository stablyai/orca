import { randomUUID } from 'node:crypto'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import type { GlobalSettings } from '../../src/shared/global-settings-types'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  waitForActivePaneHookDescriptor,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import {
  clearTerminalPtyWriteLog,
  installTerminalPtyWriteSpy,
  readTerminalPtyWriteEntries
} from './helpers/terminal-pty-write-spy'

async function enableCursorNativeChat(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const nextSettings = await window.api.settings.set({
      experimentalNativeChat: true,
      uiLanguage: 'en',
      nativeChatSessionOptions: {
        cursor: {
          model: 'gpt-5.3-codex',
          valuesByModel: {
            'gpt-5.3-codex': { effort: 'high', fastMode: false }
          }
        }
      }
    })
    window.__store?.setState({ settings: nextSettings as GlobalSettings })
  })
}

async function seedCursorSession(
  page: Page,
  args: { paneKey: string; worktreeId: string; sessionId: string }
): Promise<void> {
  await page.evaluate(({ paneKey, worktreeId, sessionId }) => {
    window.__store
      ?.getState()
      .setAgentStatus(
        paneKey,
        { state: 'working', prompt: 'Cursor Native Chat E2E', agentType: 'cursor' },
        'Cursor',
        undefined,
        { worktreeId },
        { providerSession: { key: 'conversation_id', id: sessionId } }
      )
  }, args)
}

async function toggleTerminalTabView(
  page: Page,
  args: { tabId: string; worktreeId: string }
): Promise<void> {
  await page.evaluate(({ tabId, worktreeId }) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    const state = store.getState()
    const unifiedTab = (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
      (tab) => tab.contentType === 'terminal' && tab.entityId === tabId
    )
    if (!unifiedTab) {
      throw new Error('Unified terminal tab not found')
    }
    state.toggleTabViewMode(unifiedTab.id)
  }, args)
}

function line(record: unknown): string {
  return `${JSON.stringify(record)}\n`
}

test.describe('Cursor Native Chat', () => {
  test('renders, tails, controls and preserves a Cursor conversation', async ({
    electronApp,
    orcaPage
  }, testInfo) => {
    const consoleErrors: string[] = []
    const pageErrors: string[] = []
    orcaPage.on('console', (message) => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text())
      }
    })
    orcaPage.on('pageerror', (error) => pageErrors.push(error.message))

    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)
    await installTerminalPtyWriteSpy(electronApp)

    const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
    const ptyId = await waitForActivePanePtyId(orcaPage)
    const [tabId] = descriptor.paneKey.split(':')
    const sessionId = `e2e-cursor-native-chat-${randomUUID()}`
    const isolatedHome = await electronApp.evaluate(({ app }) => app.getPath('home'))
    const transcriptDir = path.join(
      isolatedHome,
      '.cursor',
      'projects',
      'e2e-project',
      'agent-transcripts',
      sessionId
    )
    const transcriptPath = path.join(transcriptDir, `${sessionId}.jsonl`)
    mkdirSync(transcriptDir, { recursive: true })

    const userText = 'Review the Cursor Native Chat contract'
    const assistantText = 'I will inspect the resolver before changing anything.'
    writeFileSync(
      transcriptPath,
      [
        line({ role: 'user', message: { content: [{ type: 'text', text: userText }] } }),
        line({
          role: 'assistant',
          message: {
            content: [
              { type: 'text', text: assistantText },
              { type: 'tool_use', name: 'Read', input: { path: 'README.md' } }
            ]
          }
        })
      ].join('')
    )

    const screenshotDir = path.join(
      process.cwd(),
      'validation-screenshots',
      `native-chat-cursor-${Date.now()}`
    )
    mkdirSync(screenshotDir, { recursive: true })
    await testInfo.attach('validation-screenshot-dir', {
      body: screenshotDir,
      contentType: 'text/plain'
    })

    await enableCursorNativeChat(orcaPage)
    await seedCursorSession(orcaPage, {
      paneKey: descriptor.paneKey,
      worktreeId: descriptor.worktreeId,
      sessionId
    })
    await toggleTerminalTabView(orcaPage, { tabId, worktreeId: descriptor.worktreeId })

    const chatRoot = orcaPage.locator('[data-native-chat-root="true"]')
    await expect(chatRoot).toBeVisible({ timeout: 15_000 })
    await expect(chatRoot.getByText(userText)).toBeVisible({ timeout: 30_000 })
    await expect(chatRoot.getByText(assistantText)).toBeVisible()
    await expect(chatRoot.getByRole('button', { name: /Read README\.md/ })).toBeVisible()
    await expect(chatRoot.getByRole('button', { name: 'Stop the agent' })).toBeEnabled()
    await orcaPage.screenshot({ path: path.join(screenshotDir, '01-cursor-history.png') })

    await clearTerminalPtyWriteLog(electronApp)
    await chatRoot.getByRole('button', { name: 'Stop the agent' }).click()
    await expect
      .poll(async () => readTerminalPtyWriteEntries(electronApp), { timeout: 10_000 })
      .toEqual(expect.arrayContaining([expect.objectContaining({ id: ptyId, data: '\u001b' })]))

    const liveText = 'Cursor live tail is connected.'
    appendFileSync(
      transcriptPath,
      `${line({
        role: 'assistant',
        message: { content: [{ type: 'text', text: liveText }] }
      })}${line({ type: 'turn_ended', status: 'success' })}`
    )
    await expect(chatRoot.getByText(liveText)).toBeVisible({ timeout: 20_000 })

    await orcaPage.getByRole('button', { name: 'Show terminal' }).click()
    await expect(chatRoot).toHaveCount(0)
    await expect(orcaPage.getByRole('textbox', { name: 'Terminal input' })).toBeVisible()
    await orcaPage.getByRole('button', { name: 'Show chat view' }).click()
    await expect(chatRoot).toBeVisible()
    await expect(chatRoot.getByText(liveText)).toBeVisible()
    await orcaPage.screenshot({ path: path.join(screenshotDir, '02-cursor-live-restored.png') })

    const modelButton = chatRoot.getByRole('button', { name: 'Model' })
    await expect(modelButton).toBeVisible()
    await modelButton.click()
    await orcaPage.getByRole('menuitemradio', { name: 'GPT-5.3 Codex' }).click()
    const modeButton = chatRoot.getByRole('button', { name: 'Effort' })
    await expect(modeButton).toBeEnabled()
    await modeButton.click()
    await expect(orcaPage.getByText('Fast mode', { exact: true })).toBeVisible()
    await orcaPage.keyboard.press('Escape')

    await clearTerminalPtyWriteLog(electronApp)
    const prompt = 'Cursor composer routed to the active PTY'
    await chatRoot.getByPlaceholder('Send a message…').fill(prompt)
    await chatRoot.getByRole('button', { name: 'Send' }).click()
    await expect
      .poll(
        async () => {
          const entries = await readTerminalPtyWriteEntries(electronApp)
          return (
            entries.length > 0 &&
            entries.every((entry) => entry.id === ptyId) &&
            entries.some((entry) => entry.data.includes(prompt)) &&
            entries.some((entry) => entry.data.includes('\r'))
          )
        },
        { timeout: 10_000 }
      )
      .toBe(true)

    expect(consoleErrors).toEqual([])
    expect(pageErrors).toEqual([])
  })
})
