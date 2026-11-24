import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from './desktop/electron-fixtures/orca-app'
import { expect } from '@stablyai/playwright-test'

// Why: this spec asserts on an IPC return value instead of the DOM. That is
// deliberate: the decoded text is produced by the main process (parsers plus
// the aiVault:buildHandoffPack channel), and no DOM surface renders it before
// a target agent consumes it. Unit tests cover the shaping; this proves the
// real bridge, channel registration, and file decode in the shipped app.
test('handoff pack IPC decodes a codex transcript for another provider', async ({ orcaPage }) => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'orca-handoff-e2e-'))
  const sessionPath = path.join(root, 'sessions', '2026', '10', '18', 'rollout-e2e.jsonl')
  mkdirSync(path.dirname(sessionPath), { recursive: true })
  const timestamp = new Date().toISOString()
  writeFileSync(
    sessionPath,
    [
      {
        timestamp,
        type: 'session_meta',
        payload: { id: 'e2e-handoff-session', history_mode: 'paginated', cwd: '/repo/app' }
      },
      {
        timestamp,
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: { type: 'UserMessage', content: [{ type: 'text', text: 'wire the widget' }] }
        }
      },
      {
        timestamp,
        type: 'event_msg',
        payload: {
          type: 'item_completed',
          item: { type: 'AgentMessage', content: [{ type: 'Text', text: 'wired it' }] }
        }
      }
    ]
      .map((record) => JSON.stringify(record))
      .join('\n')
  )

  const bridgePresent = await orcaPage.evaluate(
    () => typeof window.api?.aiVault?.buildHandoffPack === 'function'
  )
  expect(bridgePresent).toBe(true)

  const result = await orcaPage.evaluate(
    (filePath) =>
      window.api.aiVault.buildHandoffPack({ agent: 'codex', filePath, mode: 'summary' }),
    sessionPath
  )
  expect(result.text).toContain('**user**: wire the widget')
  expect(result.text).toContain('**assistant**: wired it')
  expect(result.totalMessages).toBe(2)
  expect(result.truncated).toBe(false)

  // Why: Focused handoffs request summary, Full handoffs request full. Both
  // modes travel the same bridge, but only this proves full decodes live.
  const fullResult = await orcaPage.evaluate(
    (filePath) => window.api.aiVault.buildHandoffPack({ agent: 'codex', filePath, mode: 'full' }),
    sessionPath
  )
  expect(fullResult.text).toContain('**user**: wire the widget')
  expect(fullResult.text).toContain('**assistant**: wired it')
  expect(fullResult.truncated).toBe(false)

  const unknownAgent = await orcaPage.evaluate(
    (filePath) => window.api.aiVault.buildHandoffPack({ agent: 'opencode', filePath }),
    sessionPath
  )
  expect(unknownAgent.text).toBeNull()
})
