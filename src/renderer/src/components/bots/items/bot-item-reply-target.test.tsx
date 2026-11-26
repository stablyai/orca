// @vitest-environment happy-dom
// A draft never gets a reply target it didn't have when it started, and a box send always names its
// question or says it answers none: on the desktop's hook and on the phone's (the shared one).
import * as React from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { Bot } from '../../../../../shared/bot-types'
import { botItemAskText, type BotItemAsk } from '../../../../../shared/bots/bot-item-ask'
import type { BotItem, BotItemEvent } from '../../../../../shared/bots/bot-items'
import type { BotItemWaitingLine } from '../../../../../shared/bots/bot-item-question-answers'
import { createBotItemQuestionStepsHooks } from '../../../../../shared/bots/use-bot-item-question-steps'
import { updateNativeChatComposerDraft } from '../../native-chat/drafts/native-chat-composer-draft-store'
import { botItemCommentDraftScope } from './bot-item-comment-draft'
import { useBotItemQuestionSteps } from './use-bot-item-question-steps'

afterEach(cleanup)

const NOW = 1_800_000_000_000
const asking = (id: string, ...prompts: string[]): BotItemEvent => {
  const ask: BotItemAsk = {
    questions: prompts.map((prompt) => ({ prompt, options: [{ label: 'Yes' }, { label: 'No' }] }))
  }
  return {
    id,
    kind: 'commented',
    actor: { kind: 'bot', botId: 'agent', chatId: 'chat' },
    data: { text: botItemAskText(ask), ask },
    at: NOW
  }
}
const working: BotItem = {
  uid: 'item',
  number: 1,
  owner: { botId: 'agent', name: null },
  title: 'Ship it',
  description: null,
  doneMeans: null,
  status: 'working',
  chat: { id: 'chat', kind: 'home', title: null },
  madeBy: null,
  question: null,
  closeNote: null,
  wait: null,
  links: [],
  version: 1,
  lastEventId: 'e1',
  othersLastEventId: 'e1',
  snoozedUntil: null,
  lastActivityAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
  closedAt: null
}
const needsYou = (event: BotItemEvent): BotItem => ({
  ...working,
  status: 'needs_you',
  question: { eventId: event.id, text: String(event.data.text) }
})
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

const A = asking('e5', 'Question A?')
const B = asking('e7', 'Question B?')
const PAIR = asking('e5', 'Share access?', 'Extra checks?')
type View = { item: BotItem; events: readonly BotItemEvent[] }
const SCENARIOS: { name: string; start: View; next: View }[] = [
  {
    name: 'a one-question ask arrives mid-draft',
    start: { item: working, events: [] },
    next: { item: needsYou(A), events: [A] }
  },
  {
    name: 'the question the draft answers is replaced',
    start: { item: needsYou(A), events: [A] },
    next: { item: needsYou(B), events: [A, B] }
  },
  {
    name: 'the ask is not read yet when the draft is sent',
    start: { item: working, events: [] },
    next: { item: working, events: [] }
  },
  {
    name: 'a draft on one of several questions meets a new one-question ask',
    start: { item: needsYou(PAIR), events: [PAIR] },
    next: { item: needsYou(B), events: [PAIR, B] }
  }
]

type Posted = { questionId?: string; plain?: boolean }
type Hook = {
  line: () => BotItemWaitingLine | null
  type: (text: string) => void
  show: (view: View) => void
  send: () => void
  posted: Posted[]
}

function desktop(uid: string, start: View): Hook {
  const posted: Posted[] = []
  const hook = renderHook(
    ({ item, events }: View) =>
      useBotItemQuestionSteps(
        bot,
        { ...item, uid },
        events,
        (_t, _p, questionId, plain) => void posted.push({ questionId, plain }),
        []
      ),
    { initialProps: start }
  )
  return {
    posted,
    line: () => hook.result.current.waitingLine,
    type: (text) =>
      act(() =>
        updateNativeChatComposerDraft(botItemCommentDraftScope(bot, uid), { text }, 'immediate')
      ),
    show: (view) => hook.rerender(view),
    send: () =>
      act(() =>
        hook.result.current.fromBox('words', [], hook.result.current.waitingLine?.id ?? null)
      )
  }
}

const held = new Map<string, string>()
const phoneHooks = createBotItemQuestionStepsHooks(React, (scopeKey) => {
  const [draft, setDraft] = React.useState(held.get(scopeKey) ?? '')
  return { draft, setDraft: (next: string) => (held.set(scopeKey, next), setDraft(next)) }
})

function phone(uid: string, start: View): Hook {
  const posted: Posted[] = []
  let props = { ...start, boxEmpty: true }
  const hook = renderHook(
    ({ item, events, boxEmpty }: View & { boxEmpty: boolean }) =>
      phoneHooks.useBotItemQuestionSteps(
        uid,
        { ...item, uid },
        events,
        (_t, _p, questionId, plain) => void posted.push({ questionId, plain }),
        [],
        boxEmpty
      ),
    { initialProps: props }
  )
  return {
    posted,
    line: () => hook.result.current.waitingLine,
    type: (text) => hook.rerender((props = { ...props, boxEmpty: !text })),
    show: (view) => hook.rerender((props = { ...props, ...view })),
    send: () =>
      act(() =>
        hook.result.current.fromBox('words', [], hook.result.current.waitingLine?.id ?? null)
      )
  }
}

describe.each([
  ['desktop', desktop],
  ['phone', phone]
] as const)('%s comment box', (app, open) => {
  it.each(SCENARIOS.map((scenario, at) => [scenario.name, scenario, at] as const))(
    '%s',
    (_name, { start, next }, at) => {
      const box = open(`${app}-${at}`, start)
      box.type('words')
      const started = box.line()
      box.show(next)
      const shown = box.line()
      if (shown) {
        expect(shown.id).toBe(started?.id)
      }
      box.send()
      expect(box.posted).toHaveLength(1)
      const { questionId, plain } = box.posted[0]!
      // Named, and only the question the draft started on; else a comment of its own.
      expect(questionId === undefined ? plain : questionId).toBe(
        questionId === undefined ? true : started?.eventId
      )
    }
  )
})

it("keeps a later line a desktop step's Type your answer bound", () => {
  const posted: Posted[] = []
  const hook = renderHook(() =>
    useBotItemQuestionSteps(
      bot,
      { ...needsYou(PAIR), uid: 'second-line' },
      [PAIR],
      (_t, _p, questionId, plain) => void posted.push({ questionId, plain }),
      []
    )
  )
  // The card's Type your answer on line 2: the step binds it, then the box's shared handler runs.
  act(() => {
    hook.result.current.steps!.bind(1)
    hook.result.current.answerWaiting()
  })
  act(() =>
    updateNativeChatComposerDraft(
      botItemCommentDraftScope(bot, 'second-line'),
      { text: 'words' },
      'immediate'
    )
  )
  expect(hook.result.current.waitingLine?.id).toBe(`${PAIR.id}:1`)
})
