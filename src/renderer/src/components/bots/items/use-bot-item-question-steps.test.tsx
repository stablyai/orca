// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { Bot } from '../../../../../shared/bot-types'
import {
  botItemHeldAnswer,
  botItemHeldAnswersComment
} from '../../../../../shared/bots/bot-item-held-answers'
import { imageReferenceToken } from '../../../../../shared/native-chat/attachments/native-chat-image-reference'
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
import { botItemRefusedReplyText } from '../../../../../shared/bots/bot-item-refused-reply'
import {
  readNativeChatComposerDraft,
  updateNativeChatComposerDraft
} from '../../native-chat/drafts/native-chat-composer-draft-store'
import { readNativeChatDraftCache } from '../../native-chat/drafts/native-chat-draft-views'
import { botItemCommentDraftScope } from './bot-item-comment-draft'
import { botItemHeldAnswersScope, returnBotItemHeldAnswer } from './bot-item-held-answers'
import { useBotItemQuestionSteps } from './use-bot-item-question-steps'

afterEach(cleanup)

const NOW = 1_800_000_000_000
const HOSTS = 'Use these hostnames?'
const GO = 'Go ahead without a separate OK?'
const PLAN = 'Post the plan first?'
const ask = {
  questions: [HOSTS, GO, PLAN].map((prompt) => ({
    prompt,
    options: [{ label: 'Yes' }, { label: 'No' }]
  }))
}

// An item asking three questions, with its ask's comment as the host stores and reads it.
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
    skills?: readonly BotItemCommentSkill[]
    skipped?: readonly number[]
    intent?: BotItemPendingIntent
  }[] = []
  const send = (
    text: string,
    paths: readonly string[] = [],
    questionId?: string,
    plain?: boolean,
    skills?: readonly BotItemCommentSkill[],
    skipped?: readonly number[],
    intent?: BotItemPendingIntent
  ): void => {
    posted.push({ text, paths, questionId, plain, skills, skipped, intent })
  }
  // Its own item, so answers held on this device by another case don't carry over.
  const initialProps: {
    pending: readonly BotItemPendingComment[]
    events?: readonly BotItemEvent[]
  } = { pending: NO_PENDING }
  const hook = renderHook(
    ({ pending, events = [own] }) =>
      useBotItemQuestionSteps(bot, { ...shown, uid }, events, send, pending),
    { initialProps }
  )
  return { hook, posted }
}

it.each(['pick', 'box'] as const)(
  'holds answers until the last open line has one, then posts them all as one comment (%s)',
  (last) => {
    const { hook, posted } = steps(`picks-${last}`)
    act(() => hook.result.current.steps!.pick(2, 'Yes'))
    act(() => hook.result.current.steps!.pick(0, 'Yes'))
    expect(posted).toEqual([])
    const answer = {
      pick: () => hook.result.current.steps!.pick(1, 'No'),
      box: () => void hook.result.current.fromBox('No', [], hook.result.current.waitingLine!.id)
    }[last]
    act(answer)
    expect(posted.map(({ text }) => text)).toEqual([`${HOSTS} → Yes\n${GO} → No\n${PLAN} → Yes`])
    expect(posted[0]!.intent?.answers).toEqual(['Yes', 'No', 'Yes'])
    expect(posted[0]!.skipped).toBeUndefined()
  }
)

it.each(['folded', 'remounted'] as const)(
  "waits for a reopened line's new answer before posting on the last open line (%s)",
  (how) => {
    const uid = `reopen-then-last-${how}`
    const words = 'only the internal ones'
    let run = reopenedDraft(uid, words)
    if (how === 'remounted') {
      run.hook.unmount()
      run = steps(uid)
    } else {
      // Another line reopened and folded by its own pick: the draft keeps its line.
      act(() => run.hook.result.current.steps!.reopen(1))
      act(() => run.hook.result.current.steps!.pick(1, 'No'))
    }
    act(() => run.hook.result.current.steps!.pick(2, 'Yes'))
    expect(run.posted).toEqual([])
    enter(run.hook, words)
    expect(run.posted.map(({ text }) => text)).toEqual([
      `${HOSTS} → ${words}\n${GO} → No\n${PLAN} → Yes`
    ])
  }
)

it("keeps a reopened line waiting when the box's Enter answers another line", () => {
  const uid = 'reopen-enter-other'
  const { hook, posted } = steps(uid)
  act(() => hook.result.current.steps!.pick(0, 'Yes'))
  const words = 'Wait for the dry run'
  act(() =>
    updateNativeChatComposerDraft(botItemCommentDraftScope(bot, uid), { text: words }, 'immediate')
  )
  act(() => hook.result.current.steps!.reopen(0))
  enter(hook, words)
  act(() =>
    updateNativeChatComposerDraft(botItemCommentDraftScope(bot, uid), { text: '' }, 'immediate')
  )
  act(() => hook.result.current.steps!.pick(2, 'Yes'))
  expect(posted).toEqual([])
  expect(hook.result.current.steps!.reopened).toBe(0)
})

it("holds the set while the box's unsent words name the line a chip picks", () => {
  const uid = 'draft-then-chip'
  const words = 'Actually use private hosts'
  const { hook, posted } = reopenedDraft(uid, words)
  act(() => hook.result.current.steps!.pick(2, 'Yes'))
  act(() => hook.result.current.steps!.pick(0, 'Yes'))
  expect(posted).toEqual([])
  expect(readNativeChatComposerDraft(botItemCommentDraftScope(bot, uid)).text).toBe(words)
})

it('posts the set once a reopened line is folded back by its own pick', () => {
  const { hook, posted } = steps('reopen-confirm-last')
  act(() => hook.result.current.steps!.pick(0, 'Yes'))
  act(() => hook.result.current.steps!.pick(1, 'No'))
  act(() => hook.result.current.steps!.reopen(0))
  act(() => hook.result.current.steps!.pick(2, 'Yes'))
  expect(posted).toEqual([])
  act(() => hook.result.current.steps!.pick(0, 'Yes'))
  expect(posted.map(({ text }) => text)).toEqual([`${HOSTS} → Yes\n${GO} → No\n${PLAN} → Yes`])
})

it('swaps a pick for another, and keeps it when picked again', () => {
  const { hook, posted } = steps('swap')
  act(() => hook.result.current.steps!.pick(0, 'Yes'))
  act(() => hook.result.current.steps!.pick(0, 'No'))
  expect(hook.result.current.steps!.picks.map((pick) => pick?.words ?? null)).toEqual([
    'No',
    null,
    null
  ])
  act(() => hook.result.current.steps!.reopen(0))
  act(() => hook.result.current.steps!.pick(0, 'No'))
  expect(hook.result.current.steps!.picks.map((pick) => pick?.words ?? null)).toEqual([
    'No',
    null,
    null
  ])
  expect(hook.result.current.steps!.reopened).toBeNull()
  act(() => hook.result.current.steps!.send())
  expect(posted.map(({ text }) => text)).toEqual([`${HOSTS} → No`])
})

it('answers a reopened line from the box: Enter replaces its pick, and Send posts once', () => {
  const uid = 'reopen-typed'
  const { hook, posted } = steps(uid)
  act(() => hook.result.current.steps!.pick(0, 'Yes'))
  act(() => hook.result.current.steps!.pick(1, 'No'))
  act(() => hook.result.current.steps!.reopen(0))
  expect(hook.result.current.waitingLine?.line).toBe(HOSTS)
  const words = 'only the internal ones'
  act(() =>
    updateNativeChatComposerDraft(botItemCommentDraftScope(bot, uid), { text: words }, 'immediate')
  )
  expect(hook.result.current.waitingLine?.line).toBe(HOSTS)
  act(() => hook.result.current.fromBox(words, [], hook.result.current.waitingLine!.id))
  expect(posted).toEqual([])
  expect(hook.result.current.steps!.picks.map((pick) => pick?.words ?? null)).toEqual([
    words,
    'No',
    null
  ])
  expect(hook.result.current.steps!.reopened).toBeNull()
  act(() => hook.result.current.steps!.send())
  expect(posted.map(({ text }) => text)).toEqual([`${HOSTS} → ${words}\n${GO} → No`])
})

it("holds a typed answer as its line's pick, and names the next open line", () => {
  const { hook, posted } = steps('typed')
  const first = hook.result.current.waitingLine!
  expect(first.line).toBe(HOSTS)
  act(() => hook.result.current.fromBox('the internal ones', [], first.id))
  expect(posted).toEqual([])
  expect(hook.result.current.steps!.picks.map((pick) => pick?.words ?? null)).toEqual([
    'the internal ones',
    null,
    null
  ])
  expect(hook.result.current.waitingLine?.line).toBe(GO)
  act(() => hook.result.current.steps!.send())
  expect(posted.map(({ text }) => text)).toEqual([`${HOSTS} → the internal ones`])
  expect(posted[0]?.skipped).toEqual([1, 2])
})

it('keeps a started draft on its own line when another line reopens', () => {
  const uid = 'reopen-keeps-draft'
  const { hook, posted } = steps(uid)
  act(() => hook.result.current.steps!.pick(0, 'Yes'))
  const words = 'Wait for the dry run'
  act(() =>
    updateNativeChatComposerDraft(botItemCommentDraftScope(bot, uid), { text: words }, 'immediate')
  )
  expect(hook.result.current.waitingLine?.line).toBe(GO)
  act(() => hook.result.current.steps!.reopen(0))
  expect(hook.result.current.waitingLine?.line).toBe(GO)
  act(() => hook.result.current.steps!.pick(0, 'No'))
  const { replyMark, waitingLine } = hook.result.current
  act(() =>
    hook.result.current.fromBox(words, [], replyMark.hidden ? null : (waitingLine?.id ?? null))
  )
  expect(posted).toEqual([])
  expect(hook.result.current.steps!.picks.map((pick) => pick?.words ?? null)).toEqual([
    'No',
    words,
    null
  ])
})

it('shows "Replying to" again on a reopened line whose × was closed', () => {
  const uid = 'reopen-shows-reply'
  const { hook, posted } = steps(uid)
  act(() => hook.result.current.steps!.pick(1, 'No'))
  expect(hook.result.current.waitingLine?.line).toBe(HOSTS)
  act(() => hook.result.current.replyMark.hide())
  act(() => hook.result.current.steps!.pick(0, 'Yes'))
  act(() => hook.result.current.steps!.reopen(0))
  expect(hook.result.current.replyMark.hidden).toBe(false)
  const words = 'only the internal ones'
  act(() =>
    updateNativeChatComposerDraft(botItemCommentDraftScope(bot, uid), { text: words }, 'immediate')
  )
  const { replyMark, waitingLine } = hook.result.current
  act(() =>
    hook.result.current.fromBox(words, [], replyMark.hidden ? null : (waitingLine?.id ?? null))
  )
  expect(posted).toEqual([])
  expect(hook.result.current.steps!.picks.map((pick) => pick?.words ?? null)).toEqual([
    words,
    'No',
    null
  ])
})

// Both picked, line 0 reopened, and its replacement started in the box.
function reopenedDraft(uid: string, words: string) {
  const run = steps(uid)
  act(() => run.hook.result.current.steps!.pick(0, 'Yes'))
  act(() => run.hook.result.current.steps!.pick(1, 'No'))
  act(() => run.hook.result.current.steps!.reopen(0))
  act(() =>
    updateNativeChatComposerDraft(botItemCommentDraftScope(bot, uid), { text: words }, 'immediate')
  )
  return run
}

function enter(hook: ReturnType<typeof steps>['hook'], words: string): void {
  const { replyMark, waitingLine } = hook.result.current
  act(() =>
    hook.result.current.fromBox(words, [], replyMark.hidden ? null : (waitingLine?.id ?? null))
  )
}

it("keeps a reopened line's draft on it when another line's pick changes", () => {
  const words = 'only the internal ones'
  const { hook, posted } = reopenedDraft('reopen-other-pick', words)
  act(() => hook.result.current.steps!.pick(1, 'Yes'))
  expect(hook.result.current.steps!.reopened).toBe(0)
  enter(hook, words)
  expect(posted).toEqual([])
  expect(hook.result.current.steps!.picks.map((pick) => pick?.words ?? null)).toEqual([
    words,
    'Yes',
    null
  ])
})

it("keeps a reopened line's draft on it across a restart", () => {
  const uid = 'reopen-restart'
  const words = 'only the internal ones'
  reopenedDraft(uid, words).hook.unmount()
  const { hook, posted } = steps(uid)
  expect(hook.result.current.waitingLine?.line).toBe(HOSTS)
  enter(hook, words)
  expect(posted).toEqual([])
  expect(hook.result.current.steps!.picks.map((pick) => pick?.words ?? null)).toEqual([
    words,
    'No',
    null
  ])
})

it('posts a plain comment typed after a restart drops a reopened line, the picks along', () => {
  const uid = 'reopen-folded-restart'
  let run = steps(uid)
  // Every line picked posts at once; with no send on its way (as after a refusal), the picks stay held.
  act(() => run.hook.result.current.steps!.pick(0, 'Yes'))
  act(() => run.hook.result.current.steps!.pick(1, 'No'))
  act(() => run.hook.result.current.steps!.pick(2, 'Yes'))
  run.posted.length = 0
  act(() => run.hook.result.current.steps!.reopen(0))
  run.hook.unmount()
  run = steps(uid)
  const words = 'Thanks, looks good'
  act(() =>
    updateNativeChatComposerDraft(botItemCommentDraftScope(bot, uid), { text: words }, 'immediate')
  )
  expect(run.hook.result.current.waitingLine).toBeNull()
  enter(run.hook, words)
  expect(run.posted.map(({ text }) => text)).toEqual([
    `${HOSTS} → Yes\n${GO} → No\n${PLAN} → Yes\n${words}`
  ])
})

it('holds an answer with images, files and skills like a pick; Send posts them all as one comment', () => {
  const { hook, posted } = steps('files')
  const skill = { name: 'review', path: '/skills/review/SKILL.md' }
  const pill = '@/tmp/agent-session-attachments/0123abcd-0123-4567-89ab-0123456789ab/notes.txt'
  act(() => hook.result.current.fromBox('[Image #1] first', ['/tmp/a.png'], `e2:0`, [skill]))
  act(() =>
    hook.result.current.fromBox(
      `[Image #1] and [Image #2], ${pill} /review`,
      ['/tmp/b.png', '/tmp/c.png'],
      `e2:1`,
      [skill]
    )
  )
  // Held, both, with a line still open: nothing posts until Send.
  expect(posted).toEqual([])
  expect(hook.result.current.steps!.picks.map((pick) => pick?.images)).toEqual([
    ['/tmp/a.png'],
    ['/tmp/b.png', '/tmp/c.png'],
    undefined
  ])
  act(() => hook.result.current.steps!.send())
  expect(posted).toHaveLength(1)
  // The second line's images number after the first's.
  expect(posted[0]!.text).toBe(
    `${HOSTS} → [Image #1] first\n${GO} → [Image #2] and [Image #3], ${pill} /review`
  )
  expect(posted[0]!.paths).toEqual(['/tmp/a.png', '/tmp/b.png', '/tmp/c.png'])
  expect(posted[0]!.skills).toEqual([skill])
})

it('replaces an image answer whose words match a quick reply with the reply alone', () => {
  const { hook } = steps('replace-image')
  act(() => hook.result.current.fromBox('Yes [Image #1]', ['/tmp/a.png'], `e2:0`))
  act(() => hook.result.current.fromBox('Yes', ['/tmp/b.png'], `e2:1`))
  // Line 1 holds "Yes" with an image: picking the Yes reply replaces it, as for typed words.
  act(() => hook.result.current.steps!.pick(1, 'Yes'))
  expect(hook.result.current.steps!.picks[1]).toEqual(botItemHeldAnswer('Yes'))
  // The reply alone, picked again, stays.
  act(() => hook.result.current.steps!.pick(1, 'Yes'))
  expect(hook.result.current.steps!.picks[1]).toEqual(botItemHeldAnswer('Yes'))
})

it('keeps in the box an answer whose images the held ones would take past one comment', () => {
  const { hook, posted } = steps('too-many')
  const images = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, at) => `/tmp/${prefix}-${at}.png`)
  act(() => hook.result.current.fromBox('first', images('a', 12), `e2:0`))
  let refused: unknown = null
  act(() => {
    refused = hook.result.current.fromBox('second', images('b', 9), `e2:1`)
  })
  expect(refused).toEqual({ kind: 'images', max: 20 })
  expect(hook.result.current.steps!.picks[1]).toBeNull()
  // The box still names the line it answers.
  expect(hook.result.current.waitingLine?.line).toBe(GO)
  expect(posted).toEqual([])
})

it('posts words with no line named at once, the picks along, never answering a line', () => {
  const { hook, posted } = steps('ride-along')
  act(() => hook.result.current.steps!.pick(1, 'Yes'))
  act(() => hook.result.current.fromBox(`${HOSTS} → old answer`, [], null))
  expect(posted.map(({ text }) => text)).toEqual([`${GO} → Yes\n> ${HOSTS} → old answer`])
  expect(posted[0]!.intent?.answers).toEqual([null, 'Yes', null])
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
  expect(hook.result.current.steps!.picks).toEqual([null, botItemHeldAnswer(words), null])
  expect(posted).toEqual([])
})

it('locks the lines of a send on its way, and Send then posts nothing', () => {
  const { hook, posted } = steps('pending')
  act(() => hook.result.current.steps!.pick(0, 'Yes'))
  act(() => hook.result.current.steps!.pick(1, 'No'))
  act(() => hook.result.current.steps!.pick(2, 'Yes'))
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
  expect(hook.result.current.sent.get(intent.askId)).toEqual(['Yes', 'No', 'Yes'])
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

it('puts unsent held answers back in the box with their images and skills, as one comment', () => {
  const scope = botItemCommentDraftScope(bot, 'recover')
  const skill = { name: 'review', path: '/skills/review/SKILL.md' }
  const held = [
    botItemHeldAnswer('[Image #1] first', ['/tmp/a.png']),
    botItemHeldAnswer('[Image #1] then /review', ['/tmp/b.png'], [skill])
  ]
  const shape = { body: '', decisions: [HOSTS, GO].map((question) => ({ question, replies: [] })) }
  const { text, paths, skills } = botItemHeldAnswersComment(shape, held)
  returnBotItemHeldAnswer(scope, { words: text, images: paths, skills })
  const box = readNativeChatComposerDraft(scope)
  // Each image's chip sits where its line named it, and the skill is a pill again.
  expect(box.images.map(({ path }) => path)).toEqual(['/tmp/a.png', '/tmp/b.png'])
  const [first, second] = box.images.map(({ id }) => imageReferenceToken(id))
  expect(box.text).toBe(`${HOSTS} → ${first} first\n${GO} → ${second} then /review`)
  expect(JSON.stringify(box.document)).toContain(skill.path)
})

it('says a held answer put back in the box is not saved while storage refuses it', () => {
  const answer = botItemHeldAnswer('[Image #1] first', ['/tmp/a.png'])
  expect(returnBotItemHeldAnswer(botItemCommentDraftScope(bot, 'restore-saved'), answer)).toBe(true)
  // A full localStorage: the draft lives in memory only, so its held copy must stay.
  const setItem = vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
    throw new DOMException('full', 'QuotaExceededError')
  })
  try {
    expect(returnBotItemHeldAnswer(botItemCommentDraftScope(bot, 'restore-refused'), answer)).toBe(
      false
    )
  } finally {
    setItem.mockRestore()
  }
})

it('gives back the words of a refused send that its held picks do not keep', () => {
  const scope = 'bot-item-answers:test:refused'
  const two = {
    body: '',
    decisions: [HOSTS, GO].map((question) => ({ question, replies: [] }))
  }
  updateNativeChatComposerDraft(scope, { text: `${HOSTS} → Yes` }, 'immediate')
  // Picks alone: they stay held on the card, and nothing goes back.
  expect(
    botItemRefusedReplyText(
      { askId: 'e2', shape: two, answers: ['Yes', null] },
      `${HOSTS} → Yes`,
      readNativeChatDraftCache(scope)
    )
  ).toBe('')
  // A line's words the held picks don't keep go back.
  expect(
    botItemRefusedReplyText(
      { askId: 'e2', shape: two, answers: ['Yes', 'see the shot'] },
      `${HOSTS} → Yes\n${GO} → see the shot`,
      readNativeChatDraftCache(scope)
    )
  ).toBe('see the shot')
  // Images alone give back no words.
  expect(
    botItemRefusedReplyText(
      { askId: 'e2', shape: two, answers: ['Yes', '[Image #1]'] },
      `${HOSTS} → Yes\n${GO} → [Image #1]`,
      readNativeChatDraftCache(scope)
    )
  ).toBe('')
})

it('restores the exact freeform draft after a refused send with a held answer', () => {
  const uid = 'refused-ride-along'
  const { hook, posted } = steps(uid)
  const text = `${GO} → later\n> Keep this quote`
  act(() => hook.result.current.steps!.pick(0, 'Yes'))
  act(() => hook.result.current.fromBox(text, [], null))
  const [post] = posted
  expect(post?.text).toBe(`${HOSTS} → Yes\n> ${GO} → later\n> Keep this quote`)
  const scope = botItemHeldAnswersScope(bot, uid, 'e2')
  expect(botItemRefusedReplyText(post!.intent!, post!.text, readNativeChatDraftCache(scope))).toBe(
    text
  )
})
