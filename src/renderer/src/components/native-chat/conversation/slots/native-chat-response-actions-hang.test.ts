import { describe, expect, it } from 'vitest'

import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import type { NativeChatTurnStatus } from '../../../../../../shared/native-chat/transcript/native-chat-turn-status'
import type { NativeChatResolvedPrompt } from '../../../../../../shared/native-chat/native-chat-resolution-receipt'
import type { NativeChatTurnDiff } from '../../../../../../shared/native-chat/tools/native-chat-turn-diffs'
import { nativeChatSubagentSections } from '../../subagents/native-chat-subagent-sections'
import {
  buildNativeChatTranscriptSlots,
  type NativeChatMessageSlot
} from './native-chat-transcript-slots'

const SETTLED: NativeChatTurnStatus = { startedAt: 1, thinking: false, workedSeconds: 4 }
const DIFF: NativeChatTurnDiff = { files: [], added: 1, removed: 0, truncated: false }

function text(
  id: string,
  body: string,
  role: NativeChatMessage['role'] = 'assistant'
): NativeChatMessage {
  return { id, role, blocks: [{ type: 'text', text: body }], timestamp: 1, source: 'transcript' }
}

function workerUpdate(id: string): NativeChatMessage {
  return {
    ...text(id, 'Update from worker', 'user'),
    from: { kind: 'agent', senders: [], orchestration: null }
  }
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

type Overrides = Partial<Parameters<typeof buildNativeChatTranscriptSlots>[0]>

function build(messages: NativeChatMessage[], overrides: Overrides = {}): NativeChatMessageSlot[] {
  let turn: string | undefined
  const turnKeys = messages.map((message) => {
    // A worker's update lands inside the turn it reached, as the host attributes it.
    if (message.role === 'user' && !message.from) {
      turn = message.id
    }
    return turn
  })
  return buildNativeChatTranscriptSlots({
    messages,
    turnKeys,
    liveTurnKey: undefined,
    receipts: new Map<string, NativeChatResolvedPrompt>(),
    turnStatuses: { active: null, completedByTurn: {} },
    turnDiffs: new Map<string, NativeChatTurnDiff>(),
    expandedTurnKeys: new Set<string>(),
    isWorking: false,
    lifecycleWorking: false,
    ...overrides
  }).filter((slot): slot is NativeChatMessageSlot => slot.kind === 'message')
}

function answer(messages: NativeChatMessage[], overrides: Overrides = {}): NativeChatMessageSlot {
  const slot = build(messages, overrides).find((candidate) => candidate.message.id === 'answer')
  if (!slot) {
    throw new Error('Missing the answer row')
  }
  return slot
}

const PROMPT = text('u', 'go', 'user')
const ANSWER = text('answer', 'done')
/** One line of text: the row's minimum while its controls hang, 20px more with them in flow. */
const HANGING_PX = 24
const IN_FLOW_PX = 44

describe('response actions hang', () => {
  it("hangs above the person's own bubble and at the end of the transcript", () => {
    const followed = answer([PROMPT, ANSWER, text('u2', 'next', 'user')])
    expect(followed.actionsHang).toBe(true)
    expect(followed.estimatedHeight).toBe(HANGING_PX)
    expect(answer([PROMPT, ANSWER]).actionsHang).toBe(true)
  })

  it('keeps its own height above anything left-side in the next row', () => {
    for (const next of [
      workerUpdate('w'),
      text('n', 'notice', 'system'),
      toolRun('tool'),
      text('thought', 'thinking', 'reasoning')
    ]) {
      const slot = answer([PROMPT, ANSWER, next], { expandedTurnKeys: new Set(['u']) })
      expect([next.id, slot.actionsHang]).toEqual([next.id, undefined])
      expect([next.id, slot.estimatedHeight]).toEqual([next.id, IN_FLOW_PX])
    }
  })

  it('keeps its own height above a turn bar drawn above the next bubble', () => {
    const messages = [PROMPT, ANSWER, text('u2', 'next', 'user')]
    // The next turn's opener is not loaded, so its bar draws above the row that stands in for it.
    const barAbove = build(messages, {
      turnKeys: ['u', 'u', 'unloaded'],
      turnStatuses: { active: null, completedByTurn: { unloaded: SETTLED } }
    })
    expect(barAbove.map((slot) => [slot.message.id, slot.statusAbove, slot.actionsHang])).toEqual([
      ['u', false, undefined],
      ['answer', false, undefined],
      ['u2', true, undefined]
    ])
  })

  it('keeps its own height above what its own row draws after the message', () => {
    const next = text('u2', 'next', 'user')
    const withDiff = answer([PROMPT, ANSWER, next], { turnDiffs: new Map([['u', DIFF]]) })
    expect(withDiff.turnDiff).toBe(DIFF)
    expect(withDiff.actionsHang).toBeUndefined()

    const pullRequests = [
      {
        provider: 'github' as const,
        url: 'https://github.com/acme/app/pull/1',
        slug: { owner: 'acme', repo: 'app' },
        number: 1
      }
    ]
    const withPullRequests = answer([PROMPT, ANSWER, next], {
      openedPullRequests: new Map([['u', pullRequests]])
    })
    expect(withPullRequests.openedPullRequests).toBe(pullRequests)
    expect(withPullRequests.actionsHang).toBeUndefined()

    // Even as the last slot: the rollup is what sits under the controls.
    expect(answer([PROMPT, ANSWER], { turnDiffs: new Map([['u', DIFF]]) }).actionsHang).toBe(
      undefined
    )
  })

  it('keeps its own height above a status row drawn below the message', () => {
    // A turn keyed by the answer itself draws its bar under that row, as it does under a prompt.
    const below = answer([ANSWER, text('u2', 'next', 'user')], {
      turnKeys: ['answer', 'u2'],
      turnStatuses: { active: null, completedByTurn: { answer: SETTLED } }
    })
    expect(below.status).toBe(SETTLED)
    expect(below.statusAbove).toBe(false)
    expect(below.drawsMessage).toBe(true)
    expect(below.actionsHang).toBeUndefined()
    // Drawn above the row instead, the bar leaves nothing under the controls.
    const above = answer([ANSWER, text('u2', 'next', 'user')], {
      turnKeys: ['unloaded', 'u2'],
      turnStatuses: { active: null, completedByTurn: { unloaded: SETTLED } }
    })
    expect(above.statusAbove).toBe(true)
    expect(above.actionsHang).toBe(true)
  })

  it('charges the estimate only on a row that holds controls', () => {
    // A working turn's frontier offers no controls, so nothing is added though a card follows.
    const working = answer([PROMPT, ANSWER, workerUpdate('w')], {
      liveTurnKey: 'u',
      isWorking: true
    })
    expect(working.actionsHang).toBeUndefined()
    expect(working.estimatedHeight).toBe(HANGING_PX)
    // The turn's actions belong to its last words, so an earlier response holds none.
    const earlier = build([PROMPT, text('first', 'looking'), toolRun('tool'), ANSWER], {
      expandedTurnKeys: new Set(['u'])
    }).find((slot) => slot.message.id === 'first')
    expect(earlier?.endsResponse).toBe(false)
    expect(earlier?.estimatedHeight).toBe(HANGING_PX)
    // Spacing scales the controls with the rest of the row's chrome.
    expect(
      answer([PROMPT, ANSWER, workerUpdate('w')], {
        typography: { lineHeightPx: 22, charsPerLine: 96, spacingScale: 1.5 }
      }).estimatedHeight
    ).toBe(54)
  })

  it('keeps its own height at the end while a row draws under the transcript', () => {
    expect(answer([PROMPT, ANSWER], { tailRowBelow: true }).actionsHang).toBeUndefined()
    // Only the last slot sits above that row.
    expect(
      answer([PROMPT, ANSWER, text('u2', 'next', 'user')], { tailRowBelow: true }).actionsHang
    ).toBe(true)
  })

  it('looks past a failed send, which draws after the transcript and its tail row', () => {
    const failed: NativeChatMessage = { ...text('failed', 'retry me', 'user'), unsent: true }
    expect(answer([PROMPT, ANSWER, failed]).actionsHang).toBe(true)
    expect(answer([PROMPT, ANSWER, failed], { tailRowBelow: true }).actionsHang).toBeUndefined()
    expect(answer([PROMPT, ANSWER, failed, workerUpdate('w')]).actionsHang).toBeUndefined()
  })

  it('leaves rows that never hold response controls alone', () => {
    const slots = build([PROMPT, ANSWER, text('n', 'notice', 'system'), workerUpdate('w')])
    expect(slots.map((slot) => [slot.message.id, slot.actionsHang])).toEqual([
      ['u', undefined],
      ['answer', undefined],
      ['n', undefined],
      ['w', undefined]
    ])
  })

  it('leaves a subagent section as it was, and counts its head as left-side', () => {
    const roster: NativeChatMessage = {
      id: 'roster',
      role: 'system',
      blocks: [
        {
          type: 'subagent-group',
          groupId: 'root',
          agents: [{ id: 'worker', label: 'worker', state: 'completed' }]
        }
      ],
      timestamp: 1,
      source: 'transcript'
    }
    const child = text('child', 'reading')
    const conversation = [PROMPT, ANSWER, roster, text('u2', 'next', 'user')]
    const input: Overrides = {
      subagentSections: nativeChatSubagentSections(
        conversation,
        new Map([['worker', [{ message: child, turnKey: undefined }]]])
      ),
      subagentChoices: { sections: new Map([['worker', true]]), rosters: new Map() }
    }
    const slots = build(conversation, input)
    const inSection = slots.find((slot) => slot.message.id === 'child')
    expect(inSection?.depth).toBe(1)
    expect(inSection?.actionsHang).toBeUndefined()
    // A section's rows already keep their controls in flow: one line of text and the controls,
    // charged once by the section itself.
    expect(inSection?.estimatedHeight).toBe(22 + 20)
    expect(slots.find((slot) => slot.message.id === 'answer')?.actionsHang).toBeUndefined()
  })
})
