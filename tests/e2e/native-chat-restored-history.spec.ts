import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady, ensureTerminalVisible } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './helpers/terminal'
import {
  enableNativeChatSetting,
  toggleTerminalTabToChatView
} from './helpers/native-chat-transcript-fixture'

test('reads restored Codex history before sending another message', async ({
  orcaPage,
  electronApp,
  registerPostElectronShutdownCleanup
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage)
  const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
  const [tabId] = descriptor.paneKey.split(':')
  const sessionId = randomUUID()
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'orca-restored-history-'))
  const transcriptPath = path.join(scratch, `${sessionId}.jsonl`)
  const timestamp = new Date().toISOString()
  const lines = [
    { type: 'session_meta', timestamp, payload: { id: sessionId } },
    {
      type: 'event_msg',
      timestamp,
      payload: { type: 'user_message', message: 'A previously saved request.' }
    },
    {
      type: 'event_msg',
      timestamp,
      payload: { type: 'agent_message', message: 'A previously saved answer.' }
    }
  ]
  writeFileSync(transcriptPath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`)
  registerPostElectronShutdownCleanup(() => rm(scratch, { recursive: true, force: true }))
  await enableNativeChatSetting(orcaPage)
  await orcaPage.evaluate(
    ({ worktreeId, paneKey, tabId, sessionId, transcriptPath }) => {
      const store = window.__store!
      const now = Date.now()
      store.setState((state) => ({
        tabsByWorktree: {
          ...state.tabsByWorktree,
          [worktreeId]: state.tabsByWorktree[worktreeId].map((tab) =>
            tab.id === tabId ? { ...tab, launchAgent: 'codex' as const } : tab
          )
        },
        sleepingAgentSessionsByPaneKey: {
          ...state.sleepingAgentSessionsByPaneKey,
          [paneKey]: {
            paneKey,
            worktreeId,
            agent: 'codex' as const,
            providerSession: { key: 'session_id' as const, id: sessionId, transcriptPath },
            prompt: '',
            state: 'working' as const,
            capturedAt: now,
            updatedAt: now,
            origin: 'live' as const
          }
        }
      }))
    },
    { ...descriptor, tabId, sessionId, transcriptPath }
  )
  await toggleTerminalTabToChatView(orcaPage, { tabId, worktreeId: descriptor.worktreeId })
  const chat = orcaPage.locator('[data-native-chat-root="true"]')
  await expect(chat.getByText('A previously saved request.', { exact: true })).toBeVisible()
  await expect(chat.getByText('A previously saved answer.', { exact: true })).toBeVisible()
  await chat.screenshot({ path: testInfo.outputPath('restored-history.png') })
  expect(
    await electronApp.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows().every((window) => !window.isVisible() && !window.isFocused())
    )
  ).toBe(true)
})
