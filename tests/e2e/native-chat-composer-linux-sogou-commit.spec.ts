// Replay recorded fcitx4-sogou X11 events: pinyin keyups, plain selector/insertText for characters, Process/229 for phrases, no composition events.

import { randomUUID } from 'node:crypto'
import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { CDPSession, Locator } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { waitForActivePaneHookDescriptor, waitForActiveTerminalManager } from './helpers/terminal'

type Key = { key: string; code: string; keyCode: number }

function claudeTranscript(sessionId: string): string {
  const startedAt = Date.now() - 60_000
  return `${[
    ['user', 'hello'],
    ['assistant', 'Ready for input.']
  ]
    .map(([role, text], index) =>
      JSON.stringify({
        sessionId,
        uuid: `${sessionId}-${index}`,
        timestamp: new Date(startedAt + index * 1_000).toISOString(),
        type: role,
        message: {
          role,
          model: 'claude-opus-4',
          content: [{ type: 'text', text }]
        }
      })
    )
    .join('\n')}\n`
}

function draft(composer: Locator): Promise<string> {
  return composer.evaluate((element) =>
    Array.from(element.querySelectorAll('p'), (line) => line.textContent ?? '').join('\n')
  )
}

async function pinyinKeyUps(session: CDPSession, letters: string): Promise<void> {
  // Why: the IME grabs each pinyin keydown; the page only sees its release.
  for (const letter of letters) {
    const keyCode = letter.toUpperCase().charCodeAt(0)
    await session.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: letter,
      code: `Key${letter.toUpperCase()}`,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode
    })
  }
}

async function plainSelectorPick(
  session: CDPSession,
  selector: Key,
  text: string,
  // XIM reports the selector keydown as key NUL / keyCode 0; its keyup is the real key.
  down: Pick<Key, 'key' | 'keyCode'> = selector
): Promise<void> {
  // keyDown text produces the recorded selector → candidate keypress → insertText sequence.
  await session.send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: down.key,
    code: selector.code,
    windowsVirtualKeyCode: down.keyCode,
    nativeVirtualKeyCode: down.keyCode,
    text,
    unmodifiedText: text
  })
  await session.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: selector.key,
    code: selector.code,
    windowsVirtualKeyCode: selector.keyCode,
    nativeVirtualKeyCode: selector.keyCode
  })
}

async function processPhrasePick(session: CDPSession, selector: Key, text: string): Promise<void> {
  await session.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    key: 'Process',
    code: selector.code,
    windowsVirtualKeyCode: 229,
    nativeVirtualKeyCode: 229
  })
  await session.send('Input.insertText', { text })
  await session.send('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: selector.key,
    code: selector.code,
    windowsVirtualKeyCode: selector.keyCode,
    nativeVirtualKeyCode: selector.keyCode
  })
}

test('Linux Sogou commits land in the native chat composer', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  await waitForActiveWorktree(orcaPage)
  await ensureTerminalVisible(orcaPage)
  await waitForActiveTerminalManager(orcaPage, 30_000)
  const descriptor = await waitForActivePaneHookDescriptor(orcaPage)
  const [tabId] = descriptor.paneKey.split(':')
  const sessionId = `e2e-sogou-composer-${randomUUID()}`
  const transcriptPath = path.join(
    mkdtempSync(path.join(os.tmpdir(), 'orca-e2e-sogou-composer-')),
    `${sessionId}.jsonl`
  )
  writeFileSync(transcriptPath, claudeTranscript(sessionId))

  await orcaPage.evaluate(
    async ({ paneKey, worktreeId, tabId, sessionId, transcriptPath }) => {
      const settings = await window.api.settings.set({
        experimentalNativeChat: true
      })
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable')
      }
      store.setState({ settings })
      const state = store.getState()
      state.setAgentStatus(
        paneKey,
        { state: 'done', prompt: 'e2e sogou composer', agentType: 'claude' },
        'Claude',
        undefined,
        { worktreeId },
        {
          providerSession: { key: 'session_id', id: sessionId, transcriptPath }
        }
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
  await expect(chat.getByText('Ready for input.')).toBeVisible()
  const composer = chat.getByRole('textbox')
  await composer.click()
  await expect(composer).toBeFocused()
  const session = await orcaPage.context().newCDPSession(orcaPage)
  await composer.evaluate((element) => {
    const log: string[] = []
    for (const type of ['keydown', 'keypress', 'keyup', 'beforeinput', 'compositionstart']) {
      element.addEventListener(
        type,
        (event) => {
          const detail =
            event instanceof KeyboardEvent
              ? `${event.key}/${event.keyCode}/${event.charCode}`
              : event instanceof InputEvent
                ? `${event.inputType}/${event.data}`
                : ''
          log.push(`${type}:${detail}`)
          document.documentElement.dataset.sogouEventLog = JSON.stringify(log)
        },
        true
      )
    }
  })

  await pinyinKeyUps(session, 'ni')
  await plainSelectorPick(session, { key: ' ', code: 'Space', keyCode: 32 }, '你')
  await expect.poll(() => draft(composer)).toBe('你')
  // Guards the replay itself: it must match the recorded fixture shape.
  expect(
    await orcaPage.evaluate((): unknown =>
      JSON.parse(document.documentElement.dataset.sogouEventLog ?? '[]')
    )
  ).toEqual([
    'keyup:n/78/0',
    'keyup:i/73/0',
    'keydown: /32/0',
    `keypress: /20320/20320`,
    'beforeinput:insertText/你',
    'keyup: /32/0'
  ])

  await pinyinKeyUps(session, 'hao')
  await plainSelectorPick(session, { key: '3', code: 'Digit3', keyCode: 51 }, '浩')
  await expect.poll(() => draft(composer)).toBe('你浩')

  await pinyinKeyUps(session, 'nihao')
  await processPhrasePick(session, { key: ' ', code: 'Space', keyCode: 32 }, '你好')
  await expect.poll(() => draft(composer)).toBe('你浩你好')

  await pinyinKeyUps(session, 'ni')
  await plainSelectorPick(session, { key: ' ', code: 'Space', keyCode: 32 }, '你', {
    key: '\u0000',
    keyCode: 0
  })
  await expect.poll(() => draft(composer)).toBe('你浩你好你')

  // Client-preedit engines compose instead; the commit must land the same way.
  await session.send('Input.imeSetComposition', {
    text: '好',
    selectionStart: 1,
    selectionEnd: 1
  })
  await session.send('Input.insertText', { text: '好' })
  await expect.poll(() => draft(composer)).toBe('你浩你好你好')

  await composer.pressSequentially(' ok')
  await expect.poll(() => draft(composer)).toBe('你浩你好你好 ok')
})
