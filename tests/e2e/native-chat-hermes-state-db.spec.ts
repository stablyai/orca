import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import os from 'node:os'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './helpers/terminal'
import type { GlobalSettings } from '../../src/shared/global-settings-types'

const hermesHome = mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-hermes-'))
test.use({ orcaAppExtraEnv: { HERMES_HOME: hermesHome } })

type HermesRow = {
  id: number
  role: 'user' | 'assistant' | 'tool' | 'reasoning'
  content?: string
  tool_call_id?: string
  tool_name?: string
  tool_calls?: string
  reasoning?: string
  timestamp: number
}

function seedDatabase(sessionId: string, rows: HermesRow[]): DatabaseSync {
  const dbPath = path.join(hermesHome, 'state.db')
  const db = new DatabaseSync(dbPath)
  db.exec(`
    CREATE TABLE sessions (id TEXT PRIMARY KEY);
    CREATE TABLE messages (
      id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      tool_call_id TEXT,
      tool_calls TEXT,
      tool_name TEXT,
      timestamp REAL,
      reasoning TEXT,
      reasoning_content TEXT,
      reasoning_details TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      compacted INTEGER NOT NULL DEFAULT 0
    )
  `)
  db.prepare('INSERT INTO sessions (id) VALUES (?)').run(sessionId)
  const insert = db.prepare(`
    INSERT INTO messages (
      id, session_id, role, content, tool_call_id, tool_name, tool_calls,
      timestamp, reasoning, reasoning_content, reasoning_details
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
  `)
  for (const row of rows) {
    insert.run(
      row.id,
      sessionId,
      row.role,
      row.content ?? null,
      row.tool_call_id ?? null,
      row.tool_name ?? null,
      row.tool_calls ?? null,
      row.timestamp,
      row.reasoning ?? null
    )
  }
  return db
}

async function enableNativeChatSetting(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const nextSettings = await window.api.settings.set({ experimentalNativeChat: true })
    window.__store?.setState({ settings: nextSettings as GlobalSettings })
  })
}

async function seedHermesProviderSession(
  page: Page,
  args: { paneKey: string; worktreeId: string; sessionId: string }
): Promise<void> {
  await page.evaluate(({ paneKey, worktreeId, sessionId }) => {
    window.__store
      ?.getState()
      .setAgentStatus(
        paneKey,
        { state: 'working', prompt: 'Hermes state.db E2E probe', agentType: 'hermes' },
        'Hermes',
        undefined,
        { worktreeId },
        { providerSession: { key: 'session_id', id: sessionId } }
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
    const unifiedTab = (store.getState().unifiedTabsByWorktree[worktreeId] ?? []).find(
      (tab) => tab.contentType === 'terminal' && tab.entityId === tabId
    )
    if (!unifiedTab) {
      throw new Error('Unified terminal tab not found')
    }
    store.getState().toggleTabViewMode(unifiedTab.id)
  }, args)
}

test.describe('Native chat Hermes state.db integration', () => {
  test('loads Hermes SQLite history, renders tool/reasoning blocks, and refreshes after a DB write', async ({
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await ensureTerminalVisible(orcaPage)
    await waitForActiveTerminalManager(orcaPage, 30_000)

    const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
    const [tabId] = descriptor.paneKey.split(':')
    const sessionId = `e2e-hermes-${randomUUID()}`
    const db = seedDatabase(sessionId, [
      {
        id: 1,
        role: 'user',
        content: 'Hermes SQLite prompt',
        timestamp: 1_787_000_000
      },
      {
        id: 2,
        role: 'assistant',
        content: 'Hermes SQLite answer',
        reasoning: 'Hermes reasoning surfaced',
        tool_calls: JSON.stringify([
          { id: 'call-1', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }
        ]),
        timestamp: 1_787_000_001
      },
      {
        id: 3,
        role: 'tool',
        content: 'README contents',
        tool_call_id: 'call-1',
        tool_name: 'read_file',
        timestamp: 1_787_000_002
      }
    ])

    try {
      await enableNativeChatSetting(orcaPage)
      await seedHermesProviderSession(orcaPage, {
        paneKey: descriptor.paneKey,
        worktreeId: descriptor.worktreeId,
        sessionId
      })
      const directRead = await orcaPage.evaluate(
        (id) => window.api.nativeChat.readSession('hermes', id, 300),
        sessionId
      )
      if ('error' in directRead) {
        throw new Error(`Direct nativeChat.readSession failed: ${directRead.error}`)
      }
      if (
        !directRead.messages.some((message) =>
          message.blocks.some(
            (block) => block.type === 'text' && block.text === 'Hermes SQLite answer'
          )
        )
      ) {
        throw new Error(
          `Direct nativeChat.readSession returned unexpected rows: ${JSON.stringify(directRead)}`
        )
      }
      await toggleTerminalTabToChatView(orcaPage, { tabId, worktreeId: descriptor.worktreeId })

      const nativeChatRoot = orcaPage.locator('[data-native-chat-root="true"]')
      await expect(nativeChatRoot).toBeVisible({
        timeout: 15_000
      })
      await expect(nativeChatRoot.getByText('Hermes SQLite prompt')).toBeVisible({
        timeout: 30_000
      })
      await expect(nativeChatRoot.getByText('Hermes SQLite answer')).toBeVisible()
      await expect(nativeChatRoot.getByText('Hermes reasoning surfaced')).toBeVisible()
      await expect(nativeChatRoot.getByText('read_file')).toBeVisible()
      await nativeChatRoot
        .getByRole('button', { name: /read_file/ })
        .first()
        .click()
      await expect(
        nativeChatRoot.locator('pre').filter({ hasText: 'README contents' })
      ).toBeVisible()

      db.prepare(`
        INSERT INTO messages (id, session_id, role, content, timestamp)
        VALUES (?, ?, 'assistant', ?, ?)
      `).run(4, sessionId, 'Hermes live SQLite update', 1_787_000_003)

      await expect(nativeChatRoot.getByText('Hermes live SQLite update')).toBeVisible({
        timeout: 30_000
      })
    } finally {
      db.close()
      rmSync(hermesHome, { recursive: true, force: true })
    }
  })
})
