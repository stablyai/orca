import { describe, expect, it, vi } from 'vitest'
import * as imageSources from '../../markdown/native-chat-markdown-image-sources'
import { nativeChatAgentRowWords } from '../../messages/rows/native-chat-message-row-words'

import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'

import type { NativeChatTurnStatus } from '../../../../../../shared/native-chat/transcript/native-chat-turn-status'

import type { NativeChatResolvedPrompt } from '../../../../../../shared/native-chat/native-chat-resolution-receipt'
import type { NativeChatTurnDiff } from '../../../../../../shared/native-chat/tools/native-chat-turn-diffs'
import {
  buildNativeChatTranscriptSlots,
  type NativeChatMessageSlot
} from './native-chat-transcript-slots'

const NO_STATUSES = { active: null, completedByTurn: {} }

function text(id: string, body: string, role: NativeChatMessage['role'] = 'assistant') {
  return {
    id,
    role,
    blocks: [{ type: 'text' as const, text: body }],
    timestamp: 1,
    source: 'transcript' as const
  }
}

function build(
  messages: NativeChatMessage[],
  overrides: Partial<Parameters<typeof buildNativeChatTranscriptSlots>[0]> = {}
): NativeChatMessageSlot[] {
  let turn: string | undefined
  const turnKeys = messages.map((message) => {
    if (message.role === 'user') {
      turn = message.id
    }
    return turn
  })
  return buildNativeChatTranscriptSlots({
    messages,
    turnKeys,
    liveTurnKey: undefined,
    receipts: new Map<string, NativeChatResolvedPrompt>(),
    turnStatuses: NO_STATUSES,
    turnDiffs: new Map<string, NativeChatTurnDiff>(),
    expandedTurnKeys: new Set<string>(),
    isWorking: false,
    lifecycleWorking: false,
    ...overrides
  }).filter((slot): slot is NativeChatMessageSlot => slot.kind === 'message')
}

function toolRun(id: string): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'tool-call', name: 'shell', input: { command: 'ls' }, state: 'completed' }],
    timestamp: 1,
    source: 'transcript'
  }
}

describe('transcript slots', () => {
  it('shows completed generated output with final prose after settlement and only once when expanded', () => {
    const generated: NativeChatMessage = {
      ...text('image', ''),
      blocks: [
        { type: 'text', text: 'Generated image', presentation: 'generated-image' },
        { type: 'image-ref', path: '/tmp/elephant.png' }
      ]
    }
    const rows = [
      text('u', 'Generate.', 'user'),
      toolRun('work'),
      text('answer', 'Your elephant.'),
      generated
    ]
    const turnStatuses = {
      active: null,
      completedByTurn: { u: { startedAt: 1, thinking: false, workedSeconds: 4 } }
    }
    for (const expandedTurnKeys of [new Set<string>(), new Set(['u'])]) {
      const slots = build(rows, { turnStatuses, expandedTurnKeys })
      const answer = slots.find((slot) => slot.message.id === 'answer')!
      expect(answer.drawsMessage).toBe(true)
      expect(answer.endsResponse).toBe(true)
      const source = slots.find((slot) => slot.message.id === 'image')
      if (expandedTurnKeys.has('u')) {
        expect(nativeChatAgentRowWords(source!.message)).toBe('Generated image')
        expect(source!.endsResponse).toBe(false)
      }
      expect(answer.message.blocks).toEqual([
        { type: 'text', text: 'Your elephant.' },
        { type: 'image-ref', path: '/tmp/elephant.png' }
      ])
      expect(
        slots
          .filter((slot) => slot.drawsMessage)
          .flatMap((slot) => slot.message.blocks.filter((block) => block.type === 'image-ref'))
      ).toEqual([{ type: 'image-ref', path: '/tmp/elephant.png' }])
    }
    const embedded = build(
      [rows[0]!, generated, text('answer', '![](<file:///tmp/elephant.png>)')],
      { turnStatuses }
    )
    expect(embedded.find((slot) => slot.message.id === 'answer')?.message.blocks).toEqual([
      { type: 'text', text: '![](<file:///tmp/elephant.png>)' }
    ])
  })

  it.each([
    ['![](/tmp/p.png)', false],
    ['$$\n![](/tmp/p.png)\n$$', true],
    ['```md\n![](/tmp/p.png)\n```', true],
    ['[picture](/tmp/p.png)', true],
    ['<img src="/tmp/p.png" alt="Picture">', false],
    ['<!-- <img src="/tmp/p.png"> -->', true],
    ['`<img src="/tmp/p.png">`', true]
  ])('deduplicates only rendered image embeds in %s', (markdown, retained) => {
    const generated: NativeChatMessage = {
      ...text('image', ''),
      blocks: [
        { type: 'text', text: 'Generated image', presentation: 'generated-image' },
        { type: 'image-ref', path: '/tmp/p.png' }
      ]
    }
    const slots = build([text('u', 'Generate.', 'user'), generated, text('answer', markdown)], {
      turnStatuses: {
        active: null,
        completedByTurn: { u: { startedAt: 1, thinking: false, workedSeconds: 4 } }
      }
    })
    expect(
      slots
        .find((slot) => slot.message.id === 'answer')
        ?.message.blocks.filter((block) => block.type === 'image-ref')
    ).toEqual(retained ? [{ type: 'image-ref', path: '/tmp/p.png' }] : [])
  })

  it.each([1000, 10000])(
    'keeps completed image responses stable on the production streaming trigger at %i rows',
    (count) => {
      const generated: NativeChatMessage = {
        ...text('image', ''),
        blocks: [
          { type: 'text', text: 'Generated image', presentation: 'generated-image' },
          { type: 'image-ref', path: '/tmp/p.png' }
        ]
      }
      const rows = [
        text('u', 'Generate.', 'user'),
        generated,
        ...Array.from({ length: count - 3 }, (_, index) => text(`work-${index}`, 'Working.')),
        text('answer', 'Finished.'),
        text('live', 'Next.', 'user'),
        text('stream', 'Streaming.')
      ]
      const overrides = {
        turnStatuses: {
          active: null,
          completedByTurn: { u: { startedAt: 1, thinking: false, workedSeconds: 4 } }
        }
      }
      const reads = vi.spyOn(imageSources, 'nativeChatMarkdownImageSources')
      try {
        const first = build(rows, overrides)
        expect(reads).toHaveBeenCalledTimes(1)
        reads.mockClear()
        const next = build([...rows.slice(0, -1), text('stream', 'Streaming more.')], overrides)
        // Only live text changed: settled answers need zero source discovery and preserve row identity.
        expect(reads).not.toHaveBeenCalled()
        expect(
          next
            .filter((slot) => slot.turnKey === 'u')
            .every(
              (slot) =>
                slot.message ===
                first.find((before) => before.message.id === slot.message.id)?.message
            )
        ).toBe(true)
      } finally {
        reads.mockRestore()
      }
    }
  )

  it('draws the completed plan outside collapsed work', () => {
    const plan: NativeChatMessage = {
      ...text('plan', '# Proposed change', 'system'),
      blocks: [{ type: 'text', text: '# Proposed change', presentation: 'plan-document' }]
    }
    const slots = build(
      [
        text('u', 'Plan the change.', 'user'),
        text('preamble', 'Inspecting.'),
        toolRun('work'),
        plan
      ],
      {
        turnStatuses: {
          active: null,
          completedByTurn: { u: { startedAt: 1, thinking: false, workedSeconds: 4 } }
        }
      }
    )
    expect(slots.map((slot) => [slot.message.id, slot.drawsMessage, slot.folded])).toEqual([
      ['u', true, false],
      ['preamble', true, false],
      ['plan', true, false]
    ])
  })

  it("marks a row as continuing its turn only when the agent's next step follows", () => {
    const continuing = (messages: NativeChatMessage[]) =>
      build(messages)
        .filter((slot) => slot.continuesTurn)
        .map((slot) => slot.message.id)

    expect(continuing([text('u', 'go', 'user'), text('a', 'looking'), toolRun('b')])).toEqual([
      'u',
      'a'
    ])
    expect(
      continuing([text('u', 'go', 'user'), text('answer', 'done'), text('n', 'notice', 'system')])
    ).toEqual(['u'])
    expect(
      continuing([text('u', 'go', 'user'), text('answer', 'done'), text('u2', 'next', 'user')])
    ).toEqual(['u'])
  })

  it("gives a finished turn's actions to its last words, collapsed or expanded, though tools follow", () => {
    const settled: NativeChatTurnStatus = { startedAt: 1, thinking: false, workedSeconds: 4 }
    const messages = [
      text('u', 'Inspect the config', 'user'),
      text('a', 'I will look.'),
      toolRun('b')
    ]
    const holder = (overrides: Partial<Parameters<typeof build>[1]>) =>
      build(messages, {
        turnStatuses: { active: null, completedByTurn: { u: settled } },
        ...overrides
      })
        .filter((slot) => slot.endsResponse)
        .map((slot) => slot.message.id)

    expect(holder({})).toEqual(['a'])
    expect(holder({ expandedTurnKeys: new Set(['u']) })).toEqual(['a'])
    // Expanded, the tool sits right after it, which is what `continuesTurn` alone hid controls on.
    const expanded = build(messages, {
      turnStatuses: { active: null, completedByTurn: { u: settled } },
      expandedTurnKeys: new Set(['u'])
    })
    expect(expanded.find((slot) => slot.message.id === 'a')?.continuesTurn).toBe(true)
    // A running turn's frontier still offers nothing: its rows stay live.
    const working = build(messages, { liveTurnKey: 'u', isWorking: true })
    expect(working.find((slot) => slot.message.id === 'a')?.activeTurnIsWorking).toBe(true)
  })

  it('marks only the newest reply for always-visible actions, including while it is working', () => {
    const messages = [
      text('u1', 'first', 'user'),
      text('a1', 'first reply'),
      text('u2', 'second', 'user'),
      text('a2', 'second reply')
    ]
    for (const overrides of [{}, { liveTurnKey: 'u2', isWorking: true }]) {
      const replies = build(messages, overrides).filter((slot) => slot.endsResponse)
      expect(replies.map((slot) => [slot.message.id, slot.latestResponse === true])).toEqual([
        ['a1', false],
        ['a2', true]
      ])
    }
  })

  it("keeps a turn's actions on its text, or on its image while folding hides the text", () => {
    const image: NativeChatMessage = {
      id: 'a-image',
      role: 'assistant',
      blocks: [{ type: 'image-ref', url: 'https://example.test/picture.png' }],
      timestamp: 1,
      source: 'transcript'
    }
    const messages = [
      text('A', 'Show the picture', 'user'),
      text('a-text', 'Here is the picture.'),
      text('B', 'Inspect it next', 'user'),
      image
    ]
    const settled: NativeChatTurnStatus = { startedAt: 1, thinking: false, workedSeconds: 4 }
    const holder = (expandedTurnKeys: ReadonlySet<string>) =>
      build(messages, {
        turnKeys: ['A', 'A', 'B', 'A'],
        turnStatuses: { active: null, completedByTurn: { A: settled } },
        expandedTurnKeys
      })
        .filter((slot) => slot.endsResponse)
        .map((slot) => slot.message.id)

    expect(holder(new Set())).toEqual(['a-image'])
    expect(holder(new Set(['A']))).toEqual(['a-text'])
  })

  it('keeps a message whose only content is a turn status under it', () => {
    const status: NativeChatTurnStatus = { startedAt: 1, thinking: false, workedSeconds: 4 }
    const slots = build([text('u', '', 'user')], {
      liveTurnKey: 'u',
      turnStatuses: { active: status, completedByTurn: {} }
    })
    expect(slots).toHaveLength(1)
    expect(slots[0]?.status).toBe(status)
  })
})

// Host ownership, not nearest prompt position, controls turn folds, bars and liveness.
describe('turn-owned grouping', () => {
  // The #23621 shape: B lands mid-turn, three tool calls follow, one turn.

  it("rolls a turn's diff up once, under its last row, when another prompt lands among its rows", () => {
    // B opens its own turn but was sent before A's last row was written.
    const messages = [
      text('A', 'go', 'user'),
      toolRun('t1'),
      text('B', 'next', 'user'),
      text('a-answer', 'Done with A.'),
      toolRun('b1')
    ]
    const diff = (added: number): NativeChatTurnDiff => ({
      files: [],
      added,
      removed: 0,
      truncated: false
    })
    const slots = build(messages, {
      turnKeys: ['A', 'A', 'B', 'A', 'B'],
      turnDiffs: new Map([
        ['A', diff(1)],
        ['B', diff(2)]
      ])
    })
    expect(
      slots.filter((slot) => slot.turnDiff).map((slot) => [slot.message.id, slot.turnDiff?.added])
    ).toEqual([
      ['a-answer', 1],
      ['b1', 2]
    ])
  })

  it('keeps the opened pull request card when the turn ends in a run of tool calls', () => {
    const slots = build([text('A', 'open a PR', 'user'), toolRun('create'), toolRun('checks')], {
      openedPullRequests: new Map([
        [
          'A',
          [
            {
              provider: 'github',
              url: 'https://github.com/o/r/pull/3',
              slug: { owner: 'o', repo: 'r', host: 'github.com' },
              number: 3
            }
          ]
        ]
      ])
    })
    expect(slots.map((slot) => [slot.message.id, slot.openedPullRequests?.[0]?.number])).toEqual([
      ['A', undefined],
      ['create', 3]
    ])
  })

  it('skips only the open reasoning the live line discloses, and only while it does', () => {
    const reasoning = (id: string, state: 'running' | 'completed'): NativeChatMessage => ({
      ...text(id, 'Weighing two approaches', 'reasoning'),
      state
    })
    const live = { turnKeys: ['A', 'A', 'A'], liveTurnKey: 'A', isWorking: true }
    const rows = [text('A', 'go', 'user'), reasoning('r-1', 'running'), reasoning('r-2', 'running')]
    const ids = (overrides: Partial<Parameters<typeof build>[1]>) =>
      build(rows, { ...live, ...overrides }).map((slot) => slot.message.id)
    expect(ids({ liveReasoningId: 'r-2' })).toEqual(['A', 'r-1'])
    // Nothing discloses it (a prompt took the line, or it says something else): it draws.
    expect(ids({ liveReasoningId: null })).toEqual(['A', 'r-1', 'r-2'])
    expect(ids({})).toEqual(['A', 'r-1', 'r-2'])
  })
})
