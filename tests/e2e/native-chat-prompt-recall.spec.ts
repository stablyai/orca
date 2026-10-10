// Up/Down in the composer walk the chat's sent prompts, against real layout and key events.

import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Locator } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './helpers/terminal'

const FIRST = 'first prompt'
const MULTI_LINE = 'line one\nline two\nline three'
const WRAPPED = Array.from({ length: 60 }, (_, index) => `wrapped${index}`).join(' ')
const COMMAND = '/clear'
const PROMPTS = [
  FIRST,
  '<task-notification>background task done</task-notification>',
  MULTI_LINE,
  WRAPPED,
  COMMAND
]

function claudeTranscript(sessionId: string): string {
  const startedAt = Date.now() - 60_000
  return `${PROMPTS.flatMap((prompt, turn) =>
    [
      ['user', prompt],
      ['assistant', `Answer ${turn}.`]
    ].map(([role, text], half) =>
      JSON.stringify({
        sessionId,
        uuid: `${sessionId}-${turn}-${half}`,
        timestamp: new Date(startedAt + (turn * 2 + half) * 1_000).toISOString(),
        type: role,
        message: { role, model: 'claude-opus-4', content: [{ type: 'text', text }] }
      })
    )
  ).join('\n')}\n`
}

/** The composer's text, one line per paragraph. */
function draft(composer: Locator): Promise<string> {
  return composer.evaluate((element) =>
    Array.from(element.querySelectorAll('p'), (line) => line.textContent ?? '').join('\n')
  )
}

test('Up and Down walk the prompts already in the chat', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
  const [tabId] = descriptor.paneKey.split(':')
  const sessionId = `e2e-prompt-recall-${randomUUID()}`
  const transcriptPath = path.join(
    mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-prompt-recall-')),
    `${sessionId}.jsonl`
  )
  writeFileSync(transcriptPath, claudeTranscript(sessionId))

  await orcaPage.evaluate(
    async ({ paneKey, worktreeId, tabId, sessionId, transcriptPath }) => {
      const settings = await window.api.settings.set({ experimentalNativeChat: true })
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable')
      }
      store.setState({ settings })
      const state = store.getState()
      state.setAgentStatus(
        paneKey,
        { state: 'done', prompt: 'e2e prompt recall', agentType: 'claude' },
        'Claude',
        undefined,
        { worktreeId },
        { providerSession: { key: 'session_id', id: sessionId, transcriptPath } }
      )
      const tab = (state.unifiedTabsByWorktree[worktreeId] ?? []).find(
        (candidate) => candidate.contentType === 'terminal' && candidate.entityId === tabId
      )
      if (!tab) {
        throw new Error('Terminal tab unavailable')
      }
      state.toggleTabViewMode(tab.id)
    },
    { ...descriptor, tabId, sessionId, transcriptPath }
  )

  const chat = orcaPage.locator('[data-native-chat-root="true"]')
  await expect(chat.getByText('Answer 4.')).toBeVisible()
  const composer = chat.getByRole('textbox')
  await composer.click()
  const press = async (key: 'ArrowUp' | 'ArrowDown'): Promise<string> => {
    await orcaPage.keyboard.press(key)
    // Why: the editor learns of a caret the browser moved a task later; a person never out-types that.
    await expect
      .poll(() =>
        composer.evaluate((element) => {
          type Mounted = Element & {
            editor: {
              state: { selection: { from: number } }
              view: { posAtDOM: (node: Node, offset: number) => number }
            }
          }
          // Tiptap hangs its editor on the element it mounts.
          const isMounted = (candidate: Element): candidate is Mounted => 'editor' in candidate
          const selection = window.getSelection()
          return isMounted(element) && selection?.anchorNode
            ? element.editor.view.posAtDOM(selection.anchorNode, selection.anchorOffset) ===
                element.editor.state.selection.from
            : false
        })
      )
      .toBe(true)
    return draft(composer)
  }

  // Newest first; the recalled command does not hand the arrows to its picker.
  expect(await press('ArrowUp')).toBe(COMMAND)
  expect(await press('ArrowUp')).toBe(WRAPPED)

  // Inside a wrapped prompt Up climbs its visual lines before recalling the one before.
  let climbs = 0
  while ((await press('ArrowUp')) === WRAPPED) {
    climbs += 1
    expect(climbs).toBeLessThan(20)
  }
  expect(climbs).toBeGreaterThan(0)
  expect(await draft(composer)).toBe(MULTI_LINE)

  // Three typed lines: two presses reach the first line, the third recalls. The harness turn is skipped.
  expect(await press('ArrowUp')).toBe(MULTI_LINE)
  expect(await press('ArrowUp')).toBe(MULTI_LINE)
  expect(await press('ArrowUp')).toBe(FIRST)
  expect(await press('ArrowUp')).toBe(FIRST)

  // Down: each recalled prompt lands with the caret on its last line, so one press moves on.
  expect(await press('ArrowDown')).toBe(MULTI_LINE)
  expect(await press('ArrowDown')).toBe(WRAPPED)
  expect(await press('ArrowDown')).toBe(COMMAND)
  expect(await press('ArrowDown')).toBe('')
})
