// @vitest-environment happy-dom
// A draft never gets a reply target it didn't have when it started, and a box send always names its
// question or says it answers none: on the desktop's hook and on the phone's (the shared one).
import * as React from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../../shared/bot-types'
import { botItemAskText, type BotItemAsk } from '../../../../../shared/bots/bot-item-ask'
import type { BotItem, BotItemEvent } from '../../../../../shared/bots/bot-items'
import type { BotItemWaitingLine } from '../../../../../shared/bots/bot-item-question-answers'
import { createBotItemQuestionStepsHooks } from '../../../../../shared/bots/use-bot-item-question-steps'
import { updateNativeChatComposerDraft } from '../../native-chat/drafts/native-chat-composer-draft-store'
import { readNativeChatDraftCache } from '../../native-chat/drafts/native-chat-draft-views'
import {
  botItemReplyTargetKey,
  putBackBotItemReplyTarget,
  sessionBotItemReplyTargets
} from '../../../../../shared/bots/bot-item-reply-target'
import { botItemCommentDraftScope, returnBotItemCommentDraft } from './bot-item-comment-draft'
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
  /** The chip's ×. */
  hide: () => void
  /** Type your answer on the open question (the phone has none for one question). */
  bind?: () => void
  hidden: () => boolean
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
        [],
        true
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
    // As the box sends: the line its chip names, none once its × closed it.
    send: () =>
      act(() => {
        const { fromBox, waitingLine, replyMark } = hook.result.current
        fromBox('words', [], replyMark.hidden ? null : (waitingLine?.id ?? null))
      }),
    hide: () => act(() => hook.result.current.replyMark.hide()),
    bind: () => act(() => hook.result.current.answerWaiting()),
    hidden: () => hook.result.current.replyMark.hidden
  }
}

const held = new Map<string, string>()
const phoneHooks = createBotItemQuestionStepsHooks(React, (scopeKey) => {
  const [draft, setDraft] = React.useState(held.get(scopeKey) ?? '')
  return { draft, setDraft: (next: string) => (held.set(scopeKey, next), setDraft(next)) }
})

function phone(uid: string, start: View, boxEmpty = true): Hook {
  const posted: Posted[] = []
  let props = { ...start, boxEmpty }
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
    // As the box sends: the line its chip names, none once its × closed it.
    send: () =>
      act(() => {
        const { fromBox, waitingLine, replyMark } = hook.result.current
        fromBox('words', [], replyMark.hidden ? null : (waitingLine?.id ?? null))
      }),
    hide: () => act(() => hook.result.current.replyMark.hide()),
    hidden: () => hook.result.current.replyMark.hidden
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

describe.each([
  ['desktop', desktop],
  ['phone', phone]
] as const)('%s comment box remounted mid-draft', (app, open) => {
  it('still answers the question the draft started on', () => {
    const start = { item: needsYou(A), events: [A] }
    const first = open(`${app}-remount`, start)
    first.type('words')
    const started = first.line()
    expect(started?.eventId).toBe(A.id)
    // Leaving the item unmounts the box; its draft stays in the store.
    cleanup()
    const again = open(`${app}-remount`, start, false)
    expect(again.line()?.id).toBe(started?.id)
    again.send()
    expect(again.posted).toEqual([{ questionId: A.id, plain: false }])
  })
})

describe.each([
  ['desktop', desktop],
  ['phone', phone]
] as const)('%s comment box closed with × then remounted', (app, open) => {
  it('stays a comment of its own', () => {
    const start = { item: needsYou(A), events: [A] }
    const first = open(`${app}-closed`, start)
    first.type('words')
    first.hide()
    expect(first.hidden()).toBe(true)
    cleanup()
    const again = open(`${app}-closed`, start, false)
    expect(again.hidden()).toBe(true)
    again.send()
    expect(again.posted).toEqual([{ questionId: undefined, plain: true }])
  })
})

// A restart: every module fresh, with only what the draft storage saved.
async function launchDesktop(saved: ReadonlyMap<string, unknown>, mountBeforeLoad = false) {
  vi.resetModules()
  const drafts = '../../native-chat/drafts/'
  const storage = await import(`${drafts}native-chat-composer-draft-storage`)
  const disk = storage.createMemoryNativeChatComposerDraftStorage()
  for (const [key, value] of saved) {
    disk.drafts.set(key, value)
  }
  storage.setNativeChatComposerDraftStorageForTests(disk)
  const { hydrateNativeChatComposerDrafts } = await import(
    `${drafts}native-chat-composer-draft-load`
  )
  if (!mountBeforeLoad) {
    await hydrateNativeChatComposerDrafts()
  }
  const testing = await import('@testing-library/react')
  const { useBotItemQuestionSteps: useSteps } = await import('./use-bot-item-question-steps')
  const { flushNativeChatComposerDrafts } = await import(
    `${drafts}native-chat-composer-draft-persistence`
  )
  const { updateNativeChatComposerDraft: update } = await import(
    `${drafts}native-chat-composer-draft-store`
  )
  const posted: Posted[] = []
  const view = { ...needsYou(A), uid: 'restart' }
  const hook = testing.renderHook(() =>
    useSteps(
      bot,
      view,
      [A],
      (_t, _p, questionId, plain) => void posted.push({ questionId, plain }),
      []
    )
  )
  if (mountBeforeLoad) {
    // The item opened before the saved drafts finished loading.
    await testing.act(() => hydrateNativeChatComposerDrafts())
  }
  return {
    disk: disk.drafts,
    posted,
    hook,
    type: (text: string) =>
      testing.act(() => update(botItemCommentDraftScope(bot, 'restart'), { text }, 'immediate')),
    quit: async () => {
      flushNativeChatComposerDrafts()
      await Promise.resolve()
      testing.cleanup()
    },
    act: testing.act
  }
}

it.each([
  ['the question the draft started on', false],
  ['closed with ×, a comment of its own', true]
])('a desktop draft kept over a restart keeps %s', async (_name, close) => {
  const before = await launchDesktop(new Map())
  await before.type('words')
  const started = before.hook.result.current.waitingLine
  expect(started?.eventId).toBe(A.id)
  if (close) {
    before.act(() => before.hook.result.current.replyMark.hide())
  }
  await before.quit()
  const after = await launchDesktop(before.disk)
  const { waitingLine, replyMark, fromBox } = after.hook.result.current
  expect(waitingLine?.id).toBe(started?.id)
  expect(replyMark.hidden).toBe(close)
  after.act(() => void fromBox('words', [], replyMark.hidden ? null : (waitingLine?.id ?? null)))
  expect(after.posted).toEqual([
    close ? { questionId: undefined, plain: true } : { questionId: A.id, plain: false }
  ])
  await after.quit()
})

describe.each([
  ['desktop', desktop],
  ['phone', phone]
] as const)('%s comment box emptied while away', (app, open) => {
  it('names none when a refused reply is put back with no box open', () => {
    const uid = `${app}-emptied`
    const start = { item: needsYou(A), events: [A] }
    open(uid, start).type('words')
    cleanup()
    // Closed throughout: the draft empties, then a refused reply's words come back.
    if (app === 'desktop') {
      updateNativeChatComposerDraft(botItemCommentDraftScope(bot, uid), { text: '' }, 'immediate')
      returnBotItemCommentDraft(bot, uid, 'refused words')
    } else {
      putBackBotItemReplyTarget(sessionBotItemReplyTargets, uid)
    }
    const again = open(uid, start, false)
    expect(again.line()).toBeNull()
    again.send()
    expect(again.posted).toEqual([{ questionId: undefined, plain: true }])
  })
})

it('a desktop box open before the saved drafts load takes their target and ×', async () => {
  const before = await launchDesktop(new Map())
  await before.type('words')
  before.act(() => before.hook.result.current.replyMark.hide())
  await before.quit()
  const after = await launchDesktop(before.disk, true)
  expect(after.hook.result.current.waitingLine?.eventId).toBe(A.id)
  expect(after.hook.result.current.replyMark.hidden).toBe(true)
  await after.quit()
})

describe('changes made together in one event all land', () => {
  it("a later line's Type your answer names that line", () => {
    const uid = 'paired-line'
    const hook = renderHook(() =>
      useBotItemQuestionSteps(bot, { ...needsYou(PAIR), uid }, [PAIR], () => {}, [], true)
    )
    // The card's Type your answer on line 2: the step binds it, then the box shows "Replying to".
    act(() => {
      hook.result.current.steps!.bind(1)
      hook.result.current.replyMark.show()
    })
    act(() =>
      updateNativeChatComposerDraft(
        botItemCommentDraftScope(bot, uid),
        { text: 'words' },
        'immediate'
      )
    )
    expect(hook.result.current.waitingLine?.id).toBe(`${PAIR.id}:1`)
  })

  it('Type your answer over a draft begun before the question answers it', () => {
    const uid = 'paired-plain'
    const plainStart: View = { item: working, events: [] }
    const posted: Posted[] = []
    const hook = renderHook(
      ({ item, events }: View) =>
        useBotItemQuestionSteps(
          bot,
          { ...item, uid },
          events,
          (_t, _p, questionId, plain) => void posted.push({ questionId, plain }),
          [],
          true
        ),
      { initialProps: plainStart }
    )
    act(() =>
      updateNativeChatComposerDraft(
        botItemCommentDraftScope(bot, uid),
        { text: 'words' },
        'immediate'
      )
    )
    hook.rerender({ item: needsYou(A), events: [A] })
    expect(hook.result.current.waitingLine).toBeNull()
    act(() => {
      hook.result.current.answerWaiting()
      hook.result.current.replyMark.show()
    })
    expect(hook.result.current.waitingLine?.eventId).toBe(A.id)
    expect(hook.result.current.replyMark.hidden).toBe(false)
  })

  it('answers recovered as a comment of their own name no line', () => {
    const uid = 'paired-recover'
    const hook = renderHook(() =>
      useBotItemQuestionSteps(bot, { ...needsYou(A), uid }, [A], () => {}, [], true)
    )
    // Recovering an earlier ask's answers: none, the words go in, and "Replying to" hides.
    act(() => {
      hook.result.current.answerNone()
      updateNativeChatComposerDraft(
        botItemCommentDraftScope(bot, uid),
        { text: 'earlier' },
        'immediate'
      )
      hook.result.current.replyMark.hide()
    })
    expect(hook.result.current.waitingLine).toBeNull()
  })
})

it('two desktop boxes on one item agree on the ×', () => {
  const uid = 'two-boxes'
  const open = () =>
    renderHook(() => useBotItemQuestionSteps(bot, { ...needsYou(A), uid }, [A], () => {}, [], true))
  const one = open()
  const two = open()
  act(() =>
    updateNativeChatComposerDraft(botItemCommentDraftScope(bot, uid), { text: 'w' }, 'immediate')
  )
  act(() => one.result.current.replyMark.hide())
  expect(two.result.current.replyMark.hidden).toBe(true)
  act(() =>
    updateNativeChatComposerDraft(botItemCommentDraftScope(bot, uid), { text: 'wo' }, 'immediate')
  )
  expect(one.result.current.replyMark.hidden).toBe(true)
  expect(two.result.current.replyMark.hidden).toBe(true)
})

describe.each([
  [
    'desktop',
    (uid: string) =>
      readNativeChatDraftCache(botItemReplyTargetKey(botItemCommentDraftScope(bot, uid)))
  ],
  ['phone', (uid: string) => sessionBotItemReplyTargets.read(botItemReplyTargetKey(uid))]
] as const)('%s keeps nothing for a question that is gone', (app, kept) => {
  const opener = app === 'desktop' ? desktop : phone
  const cases: [string, (box: Hook) => void][] = [['closed with ×', (box) => box.hide()]]
  if (app === 'desktop') {
    cases.push(['chosen by Type your answer', (box) => box.bind?.()])
  }
  it.each(cases)('%s', (_name, choose) => {
    const uid = `${app}-gone-${_name}`
    const box = opener(uid, { item: needsYou(A), events: [A] })
    choose(box)
    expect(kept(uid)).not.toBe('')
    // The item is done: it reads with no question waiting.
    box.show({ item: { ...working, status: 'done' }, events: [A] })
    expect(kept(uid)).toBe('')
  })
})

describe.each([
  ['desktop', desktop],
  ['phone', phone]
] as const)('%s draft put back while the item was closed', (app, open) => {
  const cases: [string, (box: Hook) => void][] = [['closed with ×', (box) => box.hide()]]
  if (app === 'desktop') {
    cases.push(['chosen by Type your answer', (box) => box.bind?.()])
  }
  it.each(cases)('after an empty box %s, names none on a new question', (name, choose) => {
    const uid = `${app}-put-back-${name}`
    const first = open(uid, { item: needsYou(A), events: [A] })
    choose(first)
    cleanup()
    // Away: the agent asks anew and a refused reply's words come back to the box.
    if (app === 'desktop') {
      updateNativeChatComposerDraft(
        botItemCommentDraftScope(bot, uid),
        { text: 'refused words' },
        'immediate'
      )
    }
    const again = open(uid, { item: needsYou(B), events: [A, B] }, false)
    expect(again.line()).toBeNull()
    again.send()
    expect(again.posted).toEqual([{ questionId: undefined, plain: true }])
  })
})

it("editing a picked line's answer keeps that line named", () => {
  const uid = 'edit-picked'
  const hook = renderHook(() =>
    useBotItemQuestionSteps(bot, { ...needsYou(PAIR), uid }, [PAIR], () => {}, [], true)
  )
  act(() => hook.result.current.steps!.pick(1, 'Yes'))
  // The picked line's edit: the step binds it (clearing its pick), then the box fills and shows.
  act(() => {
    hook.result.current.steps!.bind(1)
    hook.result.current.replyMark.show()
    updateNativeChatComposerDraft(botItemCommentDraftScope(bot, uid), { text: 'Yes ' }, 'immediate')
  })
  expect(hook.result.current.waitingLine?.id).toBe(`${PAIR.id}:1`)
})
