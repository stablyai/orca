import { randomUUID } from 'node:crypto'
import { rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import {
  waitForActivePaneHookDescriptor,
  waitForActivePanePtyId,
  waitForActiveTerminalManager
} from './helpers/terminal'
import type { GlobalSettings } from '../../src/shared/global-settings-types'

async function enableNativeChatSetting(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const nextSettings = await window.api.settings.set({ experimentalNativeChat: true })
    window.__store?.setState({ settings: nextSettings as GlobalSettings })
  })
}

async function seedClaudeProviderSession(
  page: Page,
  args: { paneKey: string; worktreeId: string; sessionId: string; transcriptPath: string }
): Promise<void> {
  await page.evaluate(({ paneKey, worktreeId, sessionId, transcriptPath }) => {
    window.__store
      ?.getState()
      .setAgentStatus(
        paneKey,
        { state: 'done', prompt: 'native chat IME probe', agentType: 'claude' },
        'Claude',
        undefined,
        { worktreeId },
        { providerSession: { key: 'session_id', id: sessionId, transcriptPath } }
      )
  }, args)
}

async function toggleTerminalTabToChatView(
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
      throw new Error('Unified terminal tab not found for chat toggle')
    }
    state.toggleTabViewMode(unifiedTab.id)
  }, args)
}

function claudeTranscriptLines(args: {
  sessionId: string
  userText: string
  assistantText: string
}): string {
  const userTime = new Date()
  const assistantTime = new Date(userTime.getTime() + 2_000)
  return `${[
    {
      sessionId: args.sessionId,
      uuid: `${args.sessionId}-user`,
      timestamp: userTime.toISOString(),
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: args.userText }] }
    },
    {
      sessionId: args.sessionId,
      uuid: `${args.sessionId}-assistant`,
      timestamp: assistantTime.toISOString(),
      type: 'assistant',
      message: { model: 'claude-opus-4', content: [{ type: 'text', text: args.assistantText }] }
    }
  ]
    .map((line) => JSON.stringify(line))
    .join('\n')}\n`
}

async function dispatchComposerCompositionStart(page: Page): Promise<void> {
  await page.evaluate(() => {
    const composer = document.querySelector<HTMLTextAreaElement>(
      '[data-native-chat-root="true"] textarea'
    )
    if (!composer) {
      throw new Error('Native chat composer textarea not found')
    }
    composer.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
  })
}

async function dispatchComposerCompositionFrame(page: Page, text: string): Promise<void> {
  await page.evaluate((nextText) => {
    const composer = document.querySelector<HTMLTextAreaElement>(
      '[data-native-chat-root="true"] textarea'
    )
    if (!composer) {
      throw new Error('Native chat composer textarea not found')
    }
    composer.value = nextText
    composer.setSelectionRange(nextText.length, nextText.length)
    composer.dispatchEvent(
      new InputEvent('input', {
        bubbles: true,
        data: nextText,
        inputType: 'insertCompositionText'
      })
    )
  }, text)
}

async function dispatchComposerCompositionCommit(page: Page, text: string): Promise<void> {
  await page.evaluate((committedText) => {
    const composer = document.querySelector<HTMLTextAreaElement>(
      '[data-native-chat-root="true"] textarea'
    )
    if (!composer) {
      throw new Error('Native chat composer textarea not found')
    }
    composer.value = committedText
    composer.setSelectionRange(committedText.length, committedText.length)
    composer.dispatchEvent(
      new CompositionEvent('compositionend', { bubbles: true, data: committedText })
    )
  }, text)
}

test.describe('Native chat Chinese IME composition', () => {
  test('keeps Pinyin preedit text out of the composer draft until commit', async ({
    orcaPage,
    testRepoPath
  }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
    const [tabId] = descriptor.paneKey.split(':')
    const ptyId = await waitForActivePanePtyId(orcaPage)
    expect(ptyId).toBeTruthy()

    const sessionId = `e2e-native-chat-ime-${randomUUID()}`
    const transcriptPath = path.join(testRepoPath, `.orca-native-chat-ime-${sessionId}.jsonl`)
    writeFileSync(
      transcriptPath,
      claudeTranscriptLines({
        sessionId,
        userText: 'Open native chat for an IME composition probe',
        assistantText: 'Ready for Pinyin composition.'
      })
    )

    try {
      await enableNativeChatSetting(orcaPage)
      await seedClaudeProviderSession(orcaPage, {
        paneKey: descriptor.paneKey,
        worktreeId: descriptor.worktreeId,
        sessionId,
        transcriptPath
      })
      await toggleTerminalTabToChatView(orcaPage, { tabId, worktreeId: descriptor.worktreeId })

      const root = orcaPage.locator('[data-native-chat-root="true"]')
      await expect(root).toBeVisible({ timeout: 15_000 })
      await expect(orcaPage.getByText('Ready for Pinyin composition.')).toBeVisible({
        timeout: 15_000
      })

      const composer = root.locator('textarea').last()
      const sendButton = root.getByRole('button', { name: /^(Send|发送)$/ })
      await composer.focus()
      await expect(sendButton).toBeDisabled()

      await dispatchComposerCompositionStart(orcaPage)
      await dispatchComposerCompositionFrame(orcaPage, 'n')
      await expect(composer).toHaveValue('n')
      await expect(sendButton).toBeDisabled()

      await dispatchComposerCompositionFrame(orcaPage, 'ni')
      await expect(composer).toHaveValue('ni')
      await expect(sendButton).toBeDisabled()

      await dispatchComposerCompositionCommit(orcaPage, '你好')
      await expect(composer).toHaveValue('你好')
      await expect(sendButton).toBeEnabled()
    } finally {
      rmSync(transcriptPath, { force: true })
    }
  })
})
