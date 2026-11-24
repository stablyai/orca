// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { Bot } from '../../../../../shared/bot-types'
import { botItemAskText } from '../../../../../shared/bots/bot-item-ask'
import type {
  BotItem,
  BotItemCommentSkill,
  BotItemEvent
} from '../../../../../shared/bots/bot-items'
import type {
  BotItemPendingComment,
  BotItemPendingIntent
} from '../../../../../shared/bots/bot-item-pending-comments'
import { updateNativeChatComposerDraft } from '../../native-chat/drafts/native-chat-composer-draft-store'
import { readNativeChatDraftCache } from '../../native-chat/drafts/native-chat-draft-views'
import { botItemCommentDraftScope } from './bot-item-comment-draft'
import { botItemClearDeliveredAnswers } from './bot-item-held-answers'
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

const NO_PENDING: readonly BotItemPendingComment[] = []

// The item view's hook over `ask`, with every comment it posts to the host: each one wakes the agent.
function steps(uid: string, own = asking, shown = item) {
  const posted: {
    text: string
    paths: readonly string[]
    questionId?: string
    plain?: boolean
    skipped?: readonly number[]
    intent?: BotItemPendingIntent
  }[] = []
  const send = (
    text: string,
    paths: readonly string[] = [],
    questionId?: string,
    plain?: boolean,
    _skills?: readonly BotItemCommentSkill[],
    skipped?: readonly number[],
    intent?: BotItemPendingIntent
  ): void => {
    posted.push({ text, paths, questionId, plain, skipped, intent })
  }
  // Its own item, so answers held on this device by another case don't carry over.
  const hook = renderHook(
    ({
      pending,
      events = [own]
    }: {
      pending: readonly BotItemPendingComment[]
      events?: readonly BotItemEvent[]
    }) => useBotItemQuestionSteps(bot, { ...shown, uid }, events, send, pending),
    { initialProps: { pending: NO_PENDING } }
  )
  return { hook, posted }
}

it('posts nothing on a pick, the last one too; Send posts every pick as one comment', () => {
  const { hook, posted } = steps('picks')
  act(() => hook.result.current.steps!.pick(0, 'Yes'))
  act(() => hook.result.current.steps!.pick(1, 'No'))
  expect(posted).toEqual([])
  let outcome = ''
  act(() => {
    outcome = hook.result.current.steps!.send()
  })
  expect(outcome).toBe('sent')
  expect(posted.map(({ text }) => text)).toEqual([`${HOSTS} → Yes\n${GO} → No`])
  expect(posted[0]!.intent?.answers).toEqual(['Yes', 'No'])
})

it('swaps a pick for another, and clears it when picked again', () => {
  const { hook } = steps('swap')
  act(() => hook.result.current.steps!.pick(0, 'Yes'))
  act(() => hook.result.current.steps!.pick(0, 'No'))
  expect(hook.result.current.steps!.picks).toEqual(['No', null])
  act(() => hook.result.current.steps!.pick(0, 'No'))
  expect(hook.result.current.steps!.picks).toEqual([null, null])
  let outcome = ''
  act(() => {
    outcome = hook.result.current.steps!.send()
  })
  expect(outcome).toBe('empty')
})

it("holds a typed answer as its line's pick, and names the next open line", () => {
  const { hook, posted } = steps('typed')
  const first = hook.result.current.waitingLine!
  expect(first.line).toBe(HOSTS)
  act(() => hook.result.current.fromBox('the internal ones', [], first.id))
  expect(posted).toEqual([])
  expect(hook.result.current.steps!.picks).toEqual(['the internal ones', null])
  expect(hook.result.current.waitingLine?.line).toBe(GO)
  act(() => hook.result.current.steps!.send())
  expect(posted.map(({ text }) => text)).toEqual([`${HOSTS} → the internal ones`])
  expect(posted[0]?.skipped).toEqual([1])
})

it('posts a typed answer with files at once, with the picks so far', () => {
  const { hook, posted } = steps('files')
  act(() => hook.result.current.steps!.pick(0, 'Yes'))
  const line = hook.result.current.waitingLine!
  act(() => hook.result.current.fromBox('see the shot', ['/tmp/shot.png'], line.id))
  expect(posted.map(({ text, paths }) => ({ text, paths }))).toEqual([
    { text: `${HOSTS} → Yes\n${GO} → see the shot`, paths: ['/tmp/shot.png'] }
  ])
})

it('posts a typed answer naming a file at once, holding nothing', () => {
  const { hook, posted } = steps('file-pill')
  const line = hook.result.current.waitingLine!
  const pill = '@/tmp/agent-session-attachments/0123abcd-0123-4567-89ab-0123456789ab/notes.txt'
  act(() => hook.result.current.fromBox(`see ${pill}`, [], line.id))
  expect(posted.map(({ text }) => text)).toEqual([`${HOSTS} → see ${pill}`])
  expect(hook.result.current.steps!.picks).toEqual([null, null])
})

it('posts a file pill on the last open line at once, the other picks along', () => {
  const { hook, posted } = steps('file-pill-last')
  act(() => hook.result.current.steps!.pick(1, 'Yes'))
  const line = hook.result.current.waitingLine!
  expect(line.line).toBe(HOSTS)
  const pill = '@/tmp/agent-session-attachments/0123abcd-0123-4567-89ab-0123456789ab/notes.txt'
  act(() => hook.result.current.fromBox(pill, [], line.id))
  expect(posted.map(({ text }) => text)).toEqual([`${HOSTS} → ${pill}\n${GO} → Yes`])
})

it('posts words with no line named at once, the picks along, never answering a line', () => {
  const { hook, posted } = steps('ride-along')
  act(() => hook.result.current.steps!.pick(1, 'Yes'))
  act(() => hook.result.current.fromBox(`${HOSTS} → old answer`, [], null))
  expect(posted.map(({ text }) => text)).toEqual([`${GO} → Yes\n> ${HOSTS} → old answer`])
  expect(posted[0]!.intent?.answers).toEqual([null, 'Yes'])
})

it('keeps a line named by its own Type your answer in an empty box', () => {
  const { hook } = steps('bind')
  expect(hook.result.current.waitingLine?.line).toBe(HOSTS)
  act(() => hook.result.current.steps!.bind(1))
  expect(hook.result.current.waitingLine?.line).toBe(GO)
})

it('binds a new draft to the displayed question after another client answers its old target', () => {
  const uid = 'draft-after-answer'
  const { hook, posted } = steps(uid)
  act(() => hook.result.current.steps!.bind(0))
  hook.rerender({
    pending: NO_PENDING,
    events: [
      asking,
      {
        id: 'e3',
        kind: 'commented',
        actor: { kind: 'owner' },
        data: { text: `${HOSTS} → Yes` },
        at: NOW
      }
    ]
  })
  expect(hook.result.current.waitingLine?.line).toBe(GO)
  const words = 'Wait for the dry run'
  act(() =>
    updateNativeChatComposerDraft(botItemCommentDraftScope(bot, uid), { text: words }, 'immediate')
  )
  act(() => hook.result.current.fromBox(words, [], hook.result.current.waitingLine?.id ?? null))
  expect(hook.result.current.steps!.picks).toEqual([null, words])
  expect(posted).toEqual([])
})

it('locks the lines of a send on its way, and Send then posts nothing', () => {
  const { hook, posted } = steps('pending')
  act(() => hook.result.current.steps!.pick(0, 'Yes'))
  act(() => hook.result.current.steps!.pick(1, 'No'))
  act(() => hook.result.current.steps!.send())
  const intent = posted[0]!.intent!
  const entry: BotItemPendingComment = {
    event: {
      id: 'pending:1',
      kind: 'commented',
      actor: { kind: 'owner' },
      data: { text: posted[0]!.text },
      at: NOW
    },
    paths: [],
    after: 0,
    eventId: null,
    requestId: null,
    questionId: null,
    plain: false,
    intent,
    failed: false
  }
  hook.rerender({ pending: [entry] })
  expect(hook.result.current.steps!.lines).toEqual([])
  expect(hook.result.current.sent.get(intent.askId)).toEqual(['Yes', 'No'])
  let outcome = ''
  act(() => {
    outcome = hook.result.current.steps!.send()
  })
  expect(outcome).toBe('none')
  expect(posted).toHaveLength(1)
  // On its way, Send reads as sending; a failed send isn't.
  expect(hook.result.current.steps!.sending).toBe(true)
  hook.rerender({ pending: [{ ...entry, failed: true }] })
  expect(hook.result.current.steps!.sending).toBe(false)
})

it('posts a typed answer to a single question at once, naming the question it answers', () => {
  const single = { questions: [ask.questions[0]!] }
  const own: BotItemEvent = { ...asking, data: { text: botItemAskText(single), ask: single } }
  const { hook, posted } = steps('single', own, {
    ...item,
    question: { eventId: 'e2', text: botItemAskText(single) }
  })
  expect(hook.result.current.steps).toBeNull()
  const line = hook.result.current.waitingLine!
  act(() => hook.result.current.fromBox('the internal ones', [], line.id))
  expect(posted.map(({ text }) => text)).toEqual(['the internal ones'])
  // The host refuses it if the agent asked anew meanwhile.
  expect(posted.map(({ questionId }) => questionId)).toEqual(['e2'])
})

it('clears only the delivered answers still as sent, keeping lines added since', () => {
  const scope = 'bot-item-answers:test:delivered'
  const two = {
    body: '',
    decisions: [HOSTS, GO].map((question) => ({ question, replies: [] }))
  }
  // Sent: the first line. Since then the second was picked, and the ask gained a third, picked too.
  updateNativeChatComposerDraft(
    scope,
    { text: `${HOSTS} → Yes\n${GO} → No\nAnd later? → Soon` },
    'immediate'
  )
  botItemClearDeliveredAnswers(scope, { askId: 'e2', shape: two, answers: ['Yes', null] })
  expect(readNativeChatDraftCache(scope)).toBe(`${GO} → No\nAnd later? → Soon`)
  // A line changed since it was sent stays.
  botItemClearDeliveredAnswers(scope, { askId: 'e2', shape: two, answers: [null, 'Yes'] })
  expect(readNativeChatDraftCache(scope)).toBe(`${GO} → No\nAnd later? → Soon`)
})
