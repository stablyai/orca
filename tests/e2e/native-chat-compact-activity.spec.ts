import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import {
  enableExperimentalNativeChat,
  seedNativeChatProviderSession,
  toggleTerminalTabToNativeChat
} from './helpers/native-chat'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './helpers/terminal'

const EDITED_FILE = 'src/renderer/src/components/native-chat/ActivitySummary.tsx'

function compactActivityTranscript(sessionId: string): string {
  const timestamp = Date.now()
  const records = [
    {
      sessionId,
      uuid: `${sessionId}-user`,
      timestamp: new Date(timestamp).toISOString(),
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Make the native chat activity easier to review.' }]
      }
    },
    {
      sessionId,
      uuid: `${sessionId}-explanation-and-edit`,
      timestamp: new Date(timestamp + 1_000).toISOString(),
      type: 'assistant',
      message: {
        model: 'claude-opus-4',
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'I’ll tighten the activity summary first, then run the focused test.'
          },
          {
            type: 'tool_use',
            id: 'tool-edit-activity',
            name: 'Edit',
            input: {
              file_path: EDITED_FILE,
              old_string: 'const label = "Tool activity"',
              new_string: 'const label = "Completed activity"'
            }
          }
        ]
      }
    },
    {
      sessionId,
      uuid: `${sessionId}-edit-result`,
      timestamp: new Date(timestamp + 2_000).toISOString(),
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-edit-activity',
            content: `Updated ${EDITED_FILE}`,
            is_error: false
          }
        ]
      }
    },
    {
      sessionId,
      uuid: `${sessionId}-bash`,
      timestamp: new Date(timestamp + 3_000).toISOString(),
      type: 'assistant',
      message: {
        model: 'claude-opus-4',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'tool-test-activity',
            name: 'Bash',
            input: { command: 'pnpm test native-chat-turn-activity' }
          }
        ]
      }
    },
    {
      sessionId,
      uuid: `${sessionId}-bash-result`,
      timestamp: new Date(timestamp + 4_000).toISOString(),
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-test-activity',
            content: 'Tests: 12 passed, 12 total',
            is_error: false
          }
        ]
      }
    },
    {
      sessionId,
      uuid: `${sessionId}-final`,
      timestamp: new Date(timestamp + 5_000).toISOString(),
      type: 'assistant',
      message: {
        model: 'claude-opus-4',
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: 'The activity is now compact by default, with two completed operations and one reported file ready to inspect.'
          }
        ]
      }
    }
  ]
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
}

test.describe('Native chat compact activity', () => {
  test('collapses completed work and reveals operations and the reported file diff', async ({
    orcaPage
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
    const [tabId] = descriptor.paneKey.split(':')
    const sessionId = `e2e-compact-activity-${randomUUID()}`
    const scratchDir = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-native-chat-'))
    const transcriptPath = path.join(scratchDir, `${sessionId}.jsonl`)
    const screenshotDir = path.join(
      process.cwd(),
      'validation-screenshots',
      `native-chat-compact-activity-${Date.now()}`
    )
    mkdirSync(screenshotDir, { recursive: true })
    writeFileSync(transcriptPath, compactActivityTranscript(sessionId))
    await testInfo.attach('validation-screenshot-dir', {
      body: screenshotDir,
      contentType: 'text/plain'
    })

    try {
      await enableExperimentalNativeChat(orcaPage)
      await seedNativeChatProviderSession(orcaPage, {
        paneKey: descriptor.paneKey,
        worktreeId: descriptor.worktreeId,
        status: {
          state: 'done',
          prompt: 'Polish native chat activity',
          agentType: 'claude'
        },
        terminalTitle: 'Claude',
        providerSession: { id: sessionId, transcriptPath }
      })
      await toggleTerminalTabToNativeChat(orcaPage, {
        tabId,
        worktreeId: descriptor.worktreeId
      })

      const chat = orcaPage.locator('[data-native-chat-root="true"]')
      await expect(chat).toBeVisible({ timeout: 15_000 })
      // Why: focused transcript evidence excludes unrelated test-host startup
      // notices while preserving the complete message and disclosure layout.
      const transcript = chat.locator('.mx-auto.flex.w-full.max-w-4xl.flex-col.gap-5')
      await expect(transcript).toBeVisible()
      await expect(chat.getByText('I’ll tighten the activity summary first')).toBeVisible({
        timeout: 30_000
      })
      await expect(
        chat.getByText(
          'The activity is now compact by default, with two completed operations and one reported file ready to inspect.'
        )
      ).toBeVisible()

      const activity = chat.getByRole('button', { name: /2 activities/i })
      await expect(activity).toHaveAttribute('aria-expanded', 'false')
      await expect(chat.getByText('Tests: 12 passed, 12 total')).toHaveCount(0)
      await transcript.screenshot({ path: path.join(screenshotDir, '01-completed-collapsed.png') })

      await activity.click()
      await expect(activity).toHaveAttribute('aria-expanded', 'true')
      await expect(chat.getByRole('button', { name: /Edit.*ActivitySummary\.tsx/i })).toHaveCount(1)
      await expect(
        chat.getByRole('button', { name: /Bash.*pnpm test native-chat-turn-activity/i })
      ).toHaveCount(1)
      await expect(chat.getByRole('button', { name: /^Result/i })).toHaveCount(0)
      await transcript.screenshot({ path: path.join(screenshotDir, '02-activity-expanded.png') })

      const reportedFiles = chat.getByRole('button', { name: /1 reported file/i })
      await expect(reportedFiles).toHaveAttribute('aria-expanded', 'false')
      await reportedFiles.click()
      await expect(reportedFiles).toHaveAttribute('aria-expanded', 'true')
      await expect(chat.getByText(EDITED_FILE, { exact: true })).toBeVisible()

      const fileDiff = chat.getByRole('button', {
        name: /Show diff for .*ActivitySummary\.tsx/i
      })
      await fileDiff.click()
      await expect(
        chat.getByRole('button', { name: /Hide diff for .*ActivitySummary\.tsx/i })
      ).toHaveAttribute('aria-expanded', 'true')
      await expect(chat.getByText('-const label = "Tool activity"')).toBeVisible()
      await expect(chat.getByText('+const label = "Completed activity"')).toBeVisible()
      await transcript.screenshot({ path: path.join(screenshotDir, '03-file-diff-expanded.png') })

      // Why: UI evidence must cover both canonical themes without bypassing Orca's theme state.
      await orcaPage.evaluate(() => {
        const store = window.__store
        if (!store) {
          throw new Error('Store unavailable')
        }
        const state = store.getState()
        store.setState({ settings: { ...state.settings!, theme: 'dark' } })
      })
      await expect(orcaPage.locator('html')).toHaveClass(/dark/)
      await transcript.screenshot({
        path: path.join(screenshotDir, '04-file-diff-expanded-dark.png')
      })
    } finally {
      rmSync(scratchDir, { recursive: true, force: true })
    }
  })
})
