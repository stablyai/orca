// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { Bot } from '../../../../../shared/bot-types'
import type { BotItemEvent } from '../../../../../shared/bots/bot-items'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'
import { useBotItemQuestionSteps } from './use-bot-item-question-steps'
import type { BotItemPendingComment } from './use-bot-item-pending-comments'

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

const NONE_PENDING: readonly BotItemPendingComment[] = []
const NO_FILL = (): void => {}

function waitingItem(uid: string) {
  return makeTestBotItem(6, {
    uid,
    status: 'needs_you',
    question: { eventId: 'e1', text: 'Audit done.' }
  })
}

it('holds each answer, an image answer too, and posts all lines as one comment at the last', () => {
  const send = vi.fn()
  const { result } = renderHook(() =>
    useBotItemQuestionSteps(BOT, waitingItem('uid-build-up'), events, send, [], NO_FILL)
  )

  act(() => result.current.fromBox('what do other products do', [], 'e1:0'))
  act(() => result.current.fromBox('vercel sign in works [Image #1]', ['/shot.png'], 'e1:1'))

  expect(send).not.toHaveBeenCalled()
  expect(result.current.steps?.held).toEqual([
    { words: 'what do other products do', paths: [] },
    { words: 'vercel sign in works [Image #1]', paths: ['/shot.png'] },
    null
  ])
  act(() => result.current.fromBox('later [Image #1] [Image #2]', ['/a.png', '/b.png'], 'e1:2'))

  expect(send).toHaveBeenCalledExactlyOnceWith(
    'Fix Datadog with a site picker? → what do other products do\nVercel: test it or hide it? → vercel sign in works [Image #1]\nAdd a GitLab host field? → later [Image #2] [Image #3]',
    ['/shot.png', '/a.png', '/b.png'],
    'e1'
  )
})

it('keeps held answers and their images across a remount of the view', () => {
  const send = vi.fn()
  const item = waitingItem('uid-remount')
  const first = renderHook(() => useBotItemQuestionSteps(BOT, item, events, send, [], NO_FILL))
  act(() => first.result.current.fromBox('typed', [], 'e1:0'))
  act(() => first.result.current.fromBox('[Image #1]', ['/kept.png'], 'e1:1'))
  first.unmount()

  const again = renderHook(() => useBotItemQuestionSteps(BOT, item, events, send, [], NO_FILL))

  expect(again.result.current.steps?.held).toEqual([
    { words: 'typed', paths: [] },
    { words: '[Image #1]', paths: ['/kept.png'] },
    null
  ])
  expect(again.result.current.steps?.current).toBe(2)
})

it('sends the held answers early, leaves the rest open, and posts the last line alone later', () => {
  const send = vi.fn()
  const item = waitingItem('uid-early')
  const { result, rerender } = renderHook(
    (pending: readonly BotItemPendingComment[]) =>
      useBotItemQuestionSteps(BOT, item, events, send, pending, NO_FILL),
    { initialProps: NONE_PENDING }
  )
  act(() => result.current.steps?.answer(0, 'Yes'))
  act(() => result.current.fromBox('looks off [Image #1]', ['/dark.png'], 'e1:1'))

  act(() => result.current.steps?.sendNow())

  expect(send).toHaveBeenCalledExactlyOnceWith(
    'Fix Datadog with a site picker? → Yes\nVercel: test it or hide it? → looks off [Image #1]',
    ['/dark.png'],
    'e1'
  )
  // On its way to the host, the comment answers its lines.
  const onItsWay: BotItemPendingComment = {
    event: {
      id: 'pending:1',
      kind: 'commented',
      actor: { kind: 'owner' },
      data: { text: send.mock.calls[0]![0] },
      at: 5
    },
    paths: ['/dark.png'],
    after: 0,
    eventId: null,
    requestId: null,
    questionId: null,
    failed: false
  }
  rerender([onItsWay])
  expect(result.current.steps).toMatchObject({ lines: [2], current: 2, held: [null, null, null] })
  expect(result.current.waitingLine?.id).toBe('e1:2')

  act(() => result.current.fromBox('Later', [], 'e1:2'))

  expect(send).toHaveBeenLastCalledWith('Add a GitLab host field? → Later', [], 'e1')
})

it('keeps an image whose mark was deleted from the words on its own line', () => {
  const send = vi.fn()
  const { result } = renderHook(() =>
    useBotItemQuestionSteps(BOT, waitingItem('uid-unmarked'), events, send, [], NO_FILL)
  )

  act(() => result.current.fromBox('', ['/only.png'], 'e1:0'))
  act(() => result.current.fromBox('see shot', ['/shot.png'], 'e1:1'))
  act(() => result.current.fromBox('Later', [], 'e1:2'))

  expect(send).toHaveBeenCalledExactlyOnceWith(
    'Fix Datadog with a site picker? → [Image #1]\nVercel: test it or hide it? → see shot [Image #2]\nAdd a GitLab host field? → Later',
    ['/only.png', '/shot.png'],
    'e1'
  )
})

it('leaves the lines a refused comment named open until it is sent again', () => {
  const refused: BotItemPendingComment = {
    event: {
      id: 'pending:9',
      kind: 'commented',
      actor: { kind: 'owner' },
      data: { text: 'Fix Datadog with a site picker? → Yes' },
      at: 5
    },
    paths: [],
    after: 0,
    eventId: null,
    requestId: null,
    questionId: null,
    failed: true
  }
  const { result } = renderHook(() =>
    useBotItemQuestionSteps(BOT, waitingItem('uid-refused'), events, vi.fn(), [refused], NO_FILL)
  )

  expect(result.current.steps?.lines).toEqual([0, 1, 2])
})

const owner = (id: string, text: string, at: number): BotItemEvent => ({
  id,
  kind: 'commented',
  actor: { kind: 'owner' },
  data: { text },
  at
})
// The agent asks again: a new ask and its Needs you move.
const askedAgain: BotItemEvent[] = [
  {
    id: 'e9',
    kind: 'commented',
    actor: asker,
    data: {
      text: 'One more.',
      ask: {
        questions: [
          { prompt: 'Ship it?', options: [] },
          { prompt: 'When?', options: [] }
        ]
      }
    },
    at: 9
  },
  { id: 'e10', kind: 'status', actor: asker, data: { from: 'working', to: 'needs_you' }, at: 9 }
]

it('keeps a held answer to its own question when two questions start the same way', () => {
  const send = vi.fn()
  const themes = {
    questions: [
      { prompt: 'Theme?\nDesktop', options: [] },
      { prompt: 'Theme?\nPhone', options: [] },
      { prompt: 'Size?', options: [] }
    ]
  }
  const list: BotItemEvent[] = [
    { id: 'e1', kind: 'commented', actor: asker, data: { text: 'Look.', ask: themes }, at: 1 },
    events[1]!
  ]
  const { result } = renderHook(() =>
    useBotItemQuestionSteps(BOT, waitingItem('uid-themes'), list, send, [], NO_FILL)
  )

  act(() => result.current.fromBox('dark [Image #1]', ['/phone.png'], 'e1:1'))
  expect(result.current.steps?.held).toEqual([
    null,
    { words: 'dark [Image #1]', paths: ['/phone.png'] },
    null
  ])
  act(() => result.current.fromBox('large', [], 'e1:2'))
  expect(send).not.toHaveBeenCalled()
  act(() => result.current.fromBox('light', [], 'e1:0'))

  expect(send).toHaveBeenCalledExactlyOnceWith(
    '1. Theme? → light\n2. Theme? → dark [Image #1]\nSize? → large',
    ['/phone.png'],
    'e1'
  )
})

it('posts held answers once when the agent asks again, the local answer standing over one read by order', () => {
  const send = vi.fn()
  const { result, rerender } = renderHook(
    ({ list, item }: { list: BotItemEvent[]; item: ReturnType<typeof waitingItem> }) =>
      useBotItemQuestionSteps(BOT, item, list, send, [], NO_FILL),
    { initialProps: { list: events, item: waitingItem('uid-replaced') } }
  )
  act(() => result.current.fromBox('use a picker [Image #1]', ['/q1.png'], 'e1:0'))
  // A phone's plain comment takes Q1 by order; then the agent asks again.
  const list = [...events, owner('p1', 'from my phone', 3), ...askedAgain]
  const item = { ...waitingItem('uid-replaced'), question: { eventId: 'e9', text: 'One more.' } }
  rerender({ list, item })
  rerender({ list, item })

  expect(send).toHaveBeenCalledExactlyOnceWith(
    'Fix Datadog with a site picker? → use a picker [Image #1]',
    ['/q1.png'],
    // Not bound to the replaced ask: it lands after the new question on purpose.
    undefined
  )
})

it('drops a held answer another client named, and posts the rest once when the agent asks again', () => {
  const send = vi.fn()
  const { result, rerender } = renderHook(
    ({ list, item }: { list: BotItemEvent[]; item: ReturnType<typeof waitingItem> }) =>
      useBotItemQuestionSteps(BOT, item, list, send, [], NO_FILL),
    { initialProps: { list: events, item: waitingItem('uid-named') } }
  )
  act(() => result.current.fromBox('mine', [], 'e1:0'))
  act(() => result.current.fromBox('test it [Image #1]', ['/q2.png'], 'e1:1'))
  const list = [...events, owner('p1', 'Fix Datadog with a site picker? → No', 3), ...askedAgain]
  const item = { ...waitingItem('uid-named'), question: { eventId: 'e9', text: 'One more.' } }
  rerender({ list, item })

  expect(send).toHaveBeenCalledExactlyOnceWith(
    'Vercel: test it or hide it? → test it [Image #1]',
    ['/q2.png'],
    undefined
  )
})

it('keeps an edit on its own line when Send now posts that line first', () => {
  const send = vi.fn()
  const fill = vi.fn()
  const item = waitingItem('uid-edit')
  const { result, rerender } = renderHook(
    (pending: readonly BotItemPendingComment[]) =>
      useBotItemQuestionSteps(BOT, item, events, send, pending, fill),
    { initialProps: NONE_PENDING }
  )
  act(() => result.current.fromBox('first try', [], 'e1:0'))
  act(() => result.current.steps?.edit(0))
  expect(fill).toHaveBeenCalledExactlyOnceWith('first try', [])

  act(() => result.current.steps?.sendNow())
  rerender([
    {
      event: owner('pending:1', send.mock.calls[0]![0], 5),
      paths: [],
      after: 0,
      eventId: null,
      requestId: null,
      questionId: null,
      failed: false
    }
  ])
  expect(result.current.steps?.lines).toEqual([1, 2])
  expect(result.current.waitingLine?.id).toBe('e1:0')
  act(() => result.current.fromBox('second try', [], result.current.waitingLine!.id))

  expect(send).toHaveBeenLastCalledWith('Fix Datadog with a site picker? → second try', [])
  expect(result.current.steps?.held).toEqual([null, null, null])
})

it('keeps a literal [Image #1] in code as words, the image only with the line that has it', () => {
  const send = vi.fn()
  const { result } = renderHook(() =>
    useBotItemQuestionSteps(BOT, waitingItem('uid-literal'), events, send, [], NO_FILL)
  )
  act(() => result.current.fromBox('chat writes `[Image #1]`', [], 'e1:0'))
  act(() => result.current.fromBox('see [Image #1]', ['/only.png'], 'e1:1'))

  expect(result.current.steps?.held).toEqual([
    { words: 'chat writes `[Image #1]`', paths: [] },
    { words: 'see [Image #1]', paths: ['/only.png'] },
    null
  ])
})

it('splits answers whose images together pass the host limit into comments under it', () => {
  const send = vi.fn()
  const { result } = renderHook(() =>
    useBotItemQuestionSteps(BOT, waitingItem('uid-limit'), events, send, [], NO_FILL)
  )
  const shots = (name: string, count: number) =>
    Array.from({ length: count }, (_, at) => `/${name}${at}.png`)
  act(() => result.current.fromBox('eleven', shots('a', 11), 'e1:0'))
  act(() => result.current.fromBox('ten', shots('b', 10), 'e1:1'))
  act(() => result.current.fromBox('Later', [], 'e1:2'))

  expect(send.mock.calls.map(([, paths]) => paths.length)).toEqual([11, 10])
  expect(send.mock.calls[1]![0]).toMatch(
    /^Vercel: test it or hide it\? → ten .*\nAdd a GitLab host field\? → Later$/
  )
})
