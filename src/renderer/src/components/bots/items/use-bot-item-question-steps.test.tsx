// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { Bot } from '../../../../../shared/bot-types'
import { botItemAskText } from '../../../../../shared/bots/bot-item-ask'
import type { BotItem, BotItemEvent } from '../../../../../shared/bots/bot-items'
import { useBotItemQuestionSteps } from './use-bot-item-question-steps'

afterEach(cleanup)

const NOW = 1_800_000_000_000
const HOSTS = 'Use these hostnames?'
const GO = 'Go ahead without a separate OK?'
const ask = {
  questions: [HOSTS, GO].map((prompt) => ({ prompt, options: [{ label: 'Yes' }, { label: 'No' }] }))
}

// An item asking two questions, with its ask's comment as the host stores and reads it.
const asking: BotItemEvent = {
  id: 'e2',
  kind: 'commented',
  actor: { kind: 'bot', botId: 'agent', chatId: 'chat' },
  data: { text: botItemAskText(ask), ask },
  at: NOW
}
const item: BotItem = {
  uid: 'item-1',
  number: 1,
  owner: { botId: 'agent', name: null },
  title: 'Ship it',
  description: null,
  doneMeans: null,
  status: 'needs_you',
  chat: { id: 'chat', kind: 'home', title: null },
  madeBy: null,
  question: { eventId: 'e2', text: botItemAskText(ask) },
  closeNote: null,
  links: [],
  version: 2,
  lastEventId: 'e3',
  othersLastEventId: 'e3',
  snoozedUntil: null,
  lastActivityAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
  closedAt: null
}
const bot: Bot = {
  id: 'agent',
  name: 'Agent',
  hostId: 'local',
  folder: 'agent',
  folderWorkspaceId: 'fw-agent',
  agent: 'claude',
  avatar: null,
  paused: false,
  notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
  members: [],
  slack: null,
  linear: null,
  github: null,
  chatSessionId: 'chat',
  createdAt: NOW,
  updatedAt: NOW
}

// Every comment the item view's hook posts to the host: each one wakes the agent.
it('holds a typed answer to one of several questions until the last is answered', () => {
  const posted: string[] = []
  const send = (text: string): void => {
    posted.push(text)
  }
  const hook = renderHook(() => useBotItemQuestionSteps(bot, item, [asking], send, []))
  const first = hook.result.current.steps!
  act(() => hook.result.current.fromBox('the internal ones', [], `${first.askId}:${first.current}`))
  expect(posted).toEqual([])

  const next = hook.result.current.steps!
  expect(next.current).toBe(1)
  act(() => next.answer(next.current, 'Yes'))
  expect(posted).toEqual([`${HOSTS} → the internal ones\n${GO} → Yes`])
})
