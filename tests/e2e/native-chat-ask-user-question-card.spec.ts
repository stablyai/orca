import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './helpers/terminal'
import type { GlobalSettings } from '../../src/shared/global-settings-types'

const QUESTION = 'Tabs or spaces?'

async function enableNativeChatSetting(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const nextSettings = await window.api.settings.set({ experimentalNativeChat: true })
    window.__store?.setState({ settings: nextSettings as GlobalSettings })
  })
}

// Why (#11761): reproduces the paired-headless topology from the client's side —
// live status arrives carrying agent identity and a working state, but with no
// `interactivePrompt`/`toolName`, which is exactly what the host projection
// dropped. The pending ask exists only in the transcript.
async function seedStatusWithoutAskPayload(
  page: Page,
  args: { paneKey: string; worktreeId: string; sessionId: string; transcriptPath: string }
): Promise<void> {
  await page.evaluate(({ paneKey, worktreeId, sessionId, transcriptPath }) => {
    window.__store
      ?.getState()
      .setAgentStatus(
        paneKey,
        { state: 'working', prompt: 'AskUserQuestion card proof', agentType: 'claude' },
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

/** A transcript whose last assistant turn leaves an AskUserQuestion unanswered. */
function pendingAskTranscript(args: { sessionId: string; userText: string }): string {
  const userTime = new Date()
  const assistantTime = new Date(userTime.getTime() + 2_000)
  const lines = [
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
      message: {
        model: 'claude-opus-4',
        content: [
          { type: 'text', text: 'Before I reformat the file I need one decision from you.' },
          {
            type: 'tool_use',
            name: 'AskUserQuestion',
            input: {
              questions: [
                {
                  question: QUESTION,
                  header: 'Style',
                  multiSelect: false,
                  options: [{ label: 'Tabs' }, { label: 'Spaces' }]
                }
              ]
            }
          }
        ]
      }
    }
  ]
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`
}

test.describe('Desktop chat AskUserQuestion card (#11761)', () => {
  test('renders the answerable question card from the transcript when live status carries no ask', async ({
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
    const [tabId] = descriptor.paneKey.split(':')
    const sessionId = `e2e-ask-card-${randomUUID()}`

    const scratchDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-ask-card-'))
    const transcriptPath = path.join(scratchDir, `${sessionId}.jsonl`)
    const screenshotDir = path.join(process.cwd(), 'validation-screenshots', 'ask-user-question')
    mkdirSync(screenshotDir, { recursive: true })

    try {
      const userText = 'Reformat the config file for me'
      writeFileSync(transcriptPath, pendingAskTranscript({ sessionId, userText }))

      await enableNativeChatSetting(orcaPage)
      await seedStatusWithoutAskPayload(orcaPage, {
        paneKey: descriptor.paneKey,
        worktreeId: descriptor.worktreeId,
        sessionId,
        transcriptPath
      })
      await toggleTerminalTabToChatView(orcaPage, { tabId, worktreeId: descriptor.worktreeId })

      await expect(orcaPage.locator('[data-native-chat-root="true"]')).toBeVisible({
        timeout: 15_000
      })
      await expect(orcaPage.getByText(userText)).toBeVisible({ timeout: 30_000 })

      // The pre-fix build leaves the composer mounted here and never renders a
      // card, so this assertion is what actually gates the regression.
      await expect(orcaPage.getByText(QUESTION)).toBeVisible({ timeout: 10_000 })
      await expect(orcaPage.getByRole('button', { name: /Spaces/ })).toBeVisible()
      await orcaPage.screenshot({ path: path.join(screenshotDir, '01-question-card.png') })

      // The submit button reads "Skip" until an option is chosen; picking one is
      // what proves the card is answerable rather than merely rendered.
      await orcaPage.getByRole('button', { name: /Spaces/ }).click()
      await expect(orcaPage.getByRole('button', { name: 'Submit' })).toBeVisible()
      await orcaPage.screenshot({ path: path.join(screenshotDir, '02-option-selected.png') })

      await orcaPage.getByRole('button', { name: 'Submit' }).click()
      // The card owns the composer slot, so its disappearance is the visible
      // signal that the answer was accepted and chat input came back.
      await expect(orcaPage.getByText(QUESTION)).toHaveCount(0, { timeout: 20_000 })
      await orcaPage.screenshot({ path: path.join(screenshotDir, '03-answered.png') })
    } finally {
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })
})
