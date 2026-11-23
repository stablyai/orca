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
  wait: null,
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

// The item view's hook over `ask`, with every comment it posts to the host: each one wakes the agent.
function steps(uid: string, own = asking, shown = item) {
  const posted: { text: string; paths: readonly string[] }[] = []
  const answering: (string | undefined)[] = []
  const send = (text: string, paths: readonly string[] = [], questionId?: string): void => {
    posted.push({ text, paths })
    answering.push(questionId)
  }
  // Its own item, so answers held on this device by another case don't carry over.
  const hook = renderHook(() => useBotItemQuestionSteps(bot, { ...shown, uid }, [own], send, []))
  return { hook, posted, answering }
}

it('holds a typed answer to one of several questions until the last is answered', () => {
  const { hook, posted: sent } = steps('typed')
  const first = hook.result.current.steps!
  act(() => hook.result.current.fromBox('the internal ones', [], `${first.askId}:${first.current}`))
  expect(sent).toEqual([])

  const next = hook.result.current.steps!
  expect(next.current).toBe(1)
  act(() => next.answer(next.current, 'Yes'))
  expect(sent.map(({ text }) => text)).toEqual([`${HOSTS} → the internal ones\n${GO} → Yes`])
})

it('posts a typed answer with files at once, with the answers held so far', () => {
  const { hook, posted } = steps('files')
  const first = hook.result.current.steps!
  act(() => first.answer(first.current, 'Yes'))
  const next = hook.result.current.steps!
  act(() =>
    hook.result.current.fromBox('see the shot', ['/tmp/shot.png'], `${next.askId}:${next.current}`)
  )
  expect(posted).toEqual([
    { text: `${HOSTS} → Yes\n${GO} → see the shot`, paths: ['/tmp/shot.png'] }
  ])
})

it('sends the held answers when the owner sends them sooner', () => {
  const { hook, posted } = steps('send-anyway')
  const first = hook.result.current.steps!
  act(() => hook.result.current.fromBox('the internal ones', [], `${first.askId}:${first.current}`))
  expect(hook.result.current.steps!.heldCount).toBe(1)
  act(() => hook.result.current.steps!.sendHeld())
  expect(posted.map(({ text }) => text)).toEqual([`${HOSTS} → the internal ones`])
})

it('posts a typed answer to a single question at once, naming the question it answers', () => {
  const single = { questions: [ask.questions[0]!] }
  const own: BotItemEvent = { ...asking, data: { text: botItemAskText(single), ask: single } }
  const { hook, posted, answering } = steps('single', own, {
    ...item,
    question: { eventId: 'e2', text: botItemAskText(single) }
  })
  expect(hook.result.current.steps).toBeNull()
  const line = hook.result.current.waitingLine!
  act(() => hook.result.current.fromBox('the internal ones', [], line.id))
  expect(posted.map(({ text }) => text)).toEqual(['the internal ones'])
  // The host refuses it if the agent asked anew meanwhile.
  expect(answering).toEqual(['e2'])
})
