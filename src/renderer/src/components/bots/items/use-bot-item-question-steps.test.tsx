// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotItemEvent } from '../../../../../shared/bots/bot-items'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'
import { useBotItemQuestionSteps } from './use-bot-item-question-steps'

const BOT: Bot = {
  id: 'bot-a',
  name: 'Bot builder',
  hostId: 'local',
  folder: 'bot-builder',
  folderWorkspaceId: 'w1',
  agent: 'codex',
  avatar: null,
  paused: false,
  permissionMode: 'ask',
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  chatSessionId: null,
  linear: null,
  github: null,
  createdAt: 1,
  updatedAt: 1
}
const asker = { kind: 'bot', botId: 'bot-a', chatId: 'chat-home' } as const
const ask = {
  questions: [
    { prompt: 'Fix Datadog with a site picker?', options: [{ label: 'Yes' }, { label: 'No' }] },
    { prompt: 'Vercel: test it or hide it?', options: [{ label: 'Test it' }] },
    { prompt: 'Add a GitLab host field?', options: [{ label: 'Later' }] }
  ]
}
const events: BotItemEvent[] = [
  { id: 'e1', kind: 'commented', actor: asker, data: { text: 'Audit done.', ask }, at: 1 },
  { id: 'e2', kind: 'status', actor: asker, data: { from: 'working', to: 'needs_you' }, at: 1 }
]

it('posts a typed answer held for one line with the next answer that carries an image', () => {
  const send = vi.fn()
  const item = makeTestBotItem(6, {
    uid: 'uid-held-image',
    status: 'needs_you',
    question: { eventId: 'e1', text: 'Audit done.' }
  })
  const { result } = renderHook(() => useBotItemQuestionSteps(BOT, item, events, send, []))

  act(() => result.current.fromBox('what do other products do', [], 'e1:0'))
  expect(send).not.toHaveBeenCalled()
  act(() => result.current.fromBox('[Image #1] vercel sign in works', ['/shot.png'], 'e1:1'))

  expect(send).toHaveBeenCalledExactlyOnceWith(
    'Fix Datadog with a site picker? → what do other products do\nVercel: test it or hide it? → [Image #1] vercel sign in works',
    ['/shot.png'],
    'e1'
  )
})

it('sends a comment whose reply mark was closed as plain, and a named one as the answer', () => {
  const send = vi.fn()
  const item = makeTestBotItem(7, {
    uid: 'uid-closed-mark',
    status: 'needs_you',
    question: { eventId: 'e1', text: 'Audit done.' }
  })
  const { result } = renderHook(() => useBotItemQuestionSteps(BOT, item, events, send, []))

  act(() => result.current.fromBox('which one is the paired server?', [], null))
  expect(send).toHaveBeenCalledExactlyOnceWith(
    'which one is the paired server?',
    [],
    undefined,
    true
  )

  const single: BotItemEvent[] = [
    { id: 'q1', kind: 'commented', actor: asker, data: { text: 'Ship it today?' }, at: 1 },
    { id: 'q2', kind: 'status', actor: asker, data: { from: 'working', to: 'needs_you' }, at: 1 }
  ]
  const one = makeTestBotItem(8, {
    uid: 'uid-one-question',
    status: 'needs_you',
    question: { eventId: 'q1', text: 'Ship it today?' }
  })
  const { result: oneResult } = renderHook(() =>
    useBotItemQuestionSteps(BOT, one, single, send, [])
  )
  send.mockClear()
  act(() => oneResult.current.fromBox('yes', [], 'q1'))
  expect(send).toHaveBeenCalledExactlyOnceWith('yes', [], undefined, false)
  send.mockClear()
  act(() => oneResult.current.fromBox('a note', [], null))
  expect(send).toHaveBeenCalledExactlyOnceWith('a note', [], undefined, true)
})
