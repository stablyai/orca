import { expect, it } from 'vitest'
import { extractPendingAsk } from './native-chat-ask'
import { isInterruptedStatusMessage, type NativeChatMessage } from './native-chat-types'
import type { AskPrompt } from './native-chat-ask-types'

/** The pre-cursor `shift()` FIFO, verbatim, as the differential oracle. Only the
 *  canonical questions shape is exercised, so the inline parse matches production. */
function referenceExtractPendingAsk(messages: readonly NativeChatMessage[]): AskPrompt | null {
  let pending: AskPrompt | null = null
  const outstanding: (AskPrompt | null)[] = []
  for (const message of messages) {
    if (message.role === 'user' || isInterruptedStatusMessage(message)) {
      outstanding.length = 0
      pending = null
    }
    for (const block of message.blocks) {
      if (block.type === 'tool-call') {
        const input = block.input as { questions?: unknown[] } | undefined
        const parsed =
          Array.isArray(input?.questions) && input.questions.length > 0
            ? ({ questions: input.questions } as unknown as AskPrompt)
            : null
        if (parsed) {
          pending = parsed
        }
        outstanding.push(parsed)
      } else if (block.type === 'tool-result' && outstanding.length > 0) {
        const resolved = outstanding.shift()
        if (resolved && resolved === pending) {
          pending = null
        }
      }
    }
  }
  return pending
}

type Block = NativeChatMessage['blocks'][number]

function questionTexts(prompt: AskPrompt | null): string[] | null {
  return prompt ? (prompt.questions as { question?: string }[]).map((q) => q.question ?? '') : null
}

function ask(text: string): Block {
  return { type: 'tool-call', name: 'AskUserQuestion', input: { questions: [{ question: text }] } }
}
function plainCall(): Block {
  return { type: 'tool-call', name: 'Bash', input: { command: 'ls' } }
}
function toolResult(): Block {
  return { type: 'tool-result', output: 'ok' }
}
function assistant(id: string, blocks: Block[]): NativeChatMessage {
  return { id, role: 'assistant', timestamp: 1, source: 'transcript', blocks }
}
function userTurn(id: string): NativeChatMessage {
  return { id, role: 'user', timestamp: 1, source: 'transcript', blocks: [] }
}
function interrupted(id: string): NativeChatMessage {
  return {
    id,
    role: 'system',
    timestamp: 1,
    source: 'transcript',
    blocks: [{ type: 'text', text: 'Interrupted by user' }]
  } as NativeChatMessage
}

/** Deterministic PRNG so a failing sequence is reproducible from its seed. */
function makeRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0x100000000
  }
}

function randomTranscript(random: () => number, messageCount: number): NativeChatMessage[] {
  const messages: NativeChatMessage[] = []
  let askSeq = 0
  for (let m = 0; m < messageCount; m += 1) {
    const roll = random()
    if (roll < 0.12) {
      messages.push(userTurn(`u${m}`))
      continue
    }
    if (roll < 0.2) {
      messages.push(interrupted(`i${m}`))
      continue
    }
    const blocks: Block[] = []
    const blockCount = 1 + Math.floor(random() * 6)
    for (let b = 0; b < blockCount; b += 1) {
      const kind = random()
      if (kind < 0.3) {
        blocks.push(ask(`q${(askSeq += 1)}`))
      } else if (kind < 0.6) {
        blocks.push(plainCall())
      } else if (kind < 0.9) {
        blocks.push(toolResult())
      } else {
        blocks.push({ type: 'text', text: 'chatter' })
      }
    }
    messages.push(assistant(`a${m}`, blocks))
  }
  return messages
}

it('matches the shift-based FIFO on randomized add/resolve/cancel sequences', () => {
  let pendingCases = 0
  let clearedCases = 0
  for (let seed = 1; seed <= 4000; seed += 1) {
    const random = makeRandom(seed)
    const messages = randomTranscript(random, 1 + Math.floor(random() * 12))
    const actual = extractPendingAsk(messages)
    // Compare by content: the oracle keeps raw question objects, production re-parses them.
    expect(questionTexts(actual), `seed ${seed}`).toEqual(
      questionTexts(referenceExtractPendingAsk(messages))
    )
    if (actual) {
      pendingCases += 1
    } else {
      clearedCases += 1
    }
  }
  // Both verdicts must be well represented or the sweep proves nothing.
  expect(pendingCases).toBeGreaterThan(500)
  expect(clearedCases).toBeGreaterThan(500)
})

it('returns the same ask when a reconnect replays the transcript incrementally', () => {
  for (let seed = 1; seed <= 500; seed += 1) {
    const random = makeRandom(seed)
    const messages = randomTranscript(random, 1 + Math.floor(random() * 10))
    // A reconnect re-runs extraction over the whole transcript from scratch; every
    // prefix must agree with the oracle too, so no ask is dropped or shown twice
    // as frames stream back in.
    for (let end = 1; end <= messages.length; end += 1) {
      const prefix = messages.slice(0, end)
      expect(questionTexts(extractPendingAsk(prefix)), `seed ${seed} prefix ${end}`).toEqual(
        questionTexts(referenceExtractPendingAsk(prefix))
      )
    }
    // Extraction is pure: replaying the identical transcript yields the identical verdict.
    expect(extractPendingAsk(messages)).toEqual(extractPendingAsk(messages.slice()))
  }
})

it('stays linear over a large call/result batch', () => {
  const blocks: Block[] = [
    ...Array.from({ length: 100_000 }, (_, i) => ask(`q${i}`)),
    ...Array.from({ length: 100_000 }, () => toolResult())
  ]
  const started = Date.now()
  expect(extractPendingAsk([assistant('m', blocks)])).toBeNull()
  // The removed shift() FIFO was quadratic here (~5e9 element moves) and took minutes.
  expect(Date.now() - started).toBeLessThan(3000)
})

it('keeps the newest ask pending when an older duplicate-content ask resolves first', () => {
  const pending = extractPendingAsk([assistant('m', [ask('same'), ask('same'), toolResult()])])
  expect(pending?.questions[0]?.question).toBe('same')
})
