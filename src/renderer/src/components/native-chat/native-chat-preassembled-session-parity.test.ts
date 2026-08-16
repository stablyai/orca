import { describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { getVerifiedNativeChatCommands } from '../../../../shared/native-chat-agent-profiles'
import { surfaceSkillInvocationUserTurns } from '../../../../shared/native-chat-command-envelope'
import {
  createIncrementalAssembler,
  reset as resetAssembler
} from './native-chat-incremental-assembler'
import { prepareNativeChatLiveMessages } from './native-chat-live-message-preparation'
import { mergeNativeChatLiveSession } from './native-chat-live-status'
import { assembleNativeChatSession } from './native-chat-session-assembler'

const CLAUDE_COMMANDS = new Set(
  getVerifiedNativeChatCommands('claude').map((command) => command.name)
)

function message(id: string, overrides: Partial<NativeChatMessage> = {}): NativeChatMessage {
  return {
    id,
    role: 'assistant',
    blocks: [{ type: 'text', text: id }],
    timestamp: 0,
    source: 'transcript',
    ...overrides
  }
}

function expectLegacyMessageParity(transcript: NativeChatMessage[]): NativeChatMessage[] {
  const assembled = resetAssembler(createIncrementalAssembler(), transcript)
  const surfaced = surfaceSkillInvocationUserTurns(assembled, CLAUDE_COMMANDS)
  const direct = prepareNativeChatLiveMessages(assembled, 'claude')
  const legacy = assembleNativeChatSession({
    sources: { transcript: surfaced },
    sessionId: 'session-1',
    agent: 'claude'
  }).messages
  expect(direct).toEqual(legacy)
  return direct
}

describe('preassembled native-chat live sessions', () => {
  it('keeps the direct array for an ordinary single-source history', () => {
    const messages = [message('user', { role: 'user', blocks: [{ type: 'text', text: 'hello' }] })]

    expect(prepareNativeChatLiveMessages(messages, 'claude')).toBe(messages)
  })

  it('re-dedupes image-marker transforms that collide across sources', () => {
    const transcript: NativeChatMessage[] = [
      message('scrape-image', {
        role: 'user',
        blocks: [
          { type: 'image-ref', path: '/tmp/a.png' },
          { type: 'text', text: 'describe this' }
        ],
        timestamp: 1,
        source: 'scrape'
      }),
      message('image-source', {
        role: 'user',
        blocks: [{ type: 'text', text: '[Image: source: /tmp/a.png]' }],
        timestamp: 2
      }),
      message('image-prompt', {
        role: 'user',
        blocks: [{ type: 'text', text: '[Image #1] describe this' }],
        timestamp: 3
      })
    ]

    const out = expectLegacyMessageParity(transcript)

    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: 'image-prompt', source: 'transcript' })
  })

  it('keeps legacy parity for trailing image prompt markers', () => {
    const transcript: NativeChatMessage[] = [
      message('image-source', {
        role: 'user',
        blocks: [{ type: 'text', text: '[Image: source: /tmp/a.png]' }],
        timestamp: 1
      }),
      message('image-prompt', {
        role: 'user',
        blocks: [{ type: 'text', text: 'describe this[Image #1]' }],
        timestamp: 2
      })
    ]

    const out = expectLegacyMessageParity(transcript)

    expect(out).toHaveLength(1)
    expect(out[0]?.blocks).toEqual([
      { type: 'image-ref', path: '/tmp/a.png' },
      { type: 'text', text: 'describe this' }
    ])
  })

  it('re-dedupes surfaced skill envelopes that collide across sources', () => {
    const skill = (id: string, plugin: string, source: 'transcript' | 'scrape') =>
      message(id, {
        role: 'user',
        blocks: [
          {
            type: 'text',
            text: `<command-name>/${plugin}:review</command-name>\n<command-args>focus</command-args>`
          }
        ],
        timestamp: source === 'scrape' ? 1 : 2,
        source
      })
    const transcript = [
      skill('scrape-skill', 'plugin-a', 'scrape'),
      skill('skill', 'plugin-b', 'transcript')
    ]

    const out = expectLegacyMessageParity(transcript)

    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ id: 'skill', source: 'transcript' })
    expect(out[0]?.blocks).toEqual([{ type: 'text', text: '/review focus' }])
  })

  it('re-dedupes unchanged mixed-source histories after the first pass reorders them', () => {
    const transcript = [
      message('scrape-1', {
        role: 'user',
        blocks: [{ type: 'text', text: 'same prompt' }],
        timestamp: 3,
        source: 'scrape'
      }),
      message('scrape-2', {
        role: 'user',
        blocks: [{ type: 'text', text: 'same prompt' }],
        timestamp: 2,
        source: 'scrape'
      }),
      message('transcript', {
        role: 'user',
        blocks: [{ type: 'text', text: 'same prompt' }],
        timestamp: 1
      })
    ]

    const out = expectLegacyMessageParity(transcript)

    expect(out.map((entry) => entry.id)).toEqual(['transcript'])
  })

  it('keeps status inference on the pre-dedup transcript tail', () => {
    const transcript = [
      message('scrape-1', {
        role: 'user',
        blocks: [{ type: 'text', text: 'same prompt' }],
        timestamp: 4,
        source: 'scrape'
      }),
      message('scrape-2', {
        role: 'user',
        blocks: [{ type: 'text', text: 'same prompt' }],
        timestamp: 3,
        source: 'scrape'
      }),
      message('transcript', {
        role: 'user',
        blocks: [{ type: 'text', text: 'same prompt' }],
        timestamp: 1
      }),
      message('answer', { blocks: [{ type: 'text', text: 'done' }], timestamp: 2 })
    ]
    const assembled = resetAssembler(createIncrementalAssembler(), transcript)
    const prepared = prepareNativeChatLiveMessages(assembled, 'claude')

    const session = mergeNativeChatLiveSession({
      messages: prepared,
      sessionId: 'session-1',
      agent: 'claude',
      hookState: 'working',
      stateStartedAt: 2,
      statusTailMessage: assembled.at(-1)
    })

    expect(prepared.map((entry) => entry.id)).toEqual(['transcript', 'answer'])
    expect(session.status).toBe('working')
  })

  it('matches the legacy rebuild for images, tools, missing turn ids, and skills', () => {
    const transcript: NativeChatMessage[] = [
      message('scrape-duplicate', {
        role: 'user',
        blocks: [{ type: 'text', text: 'repeat this' }],
        timestamp: null,
        source: 'scrape'
      }),
      message('same-prompt-2', {
        role: 'user',
        blocks: [{ type: 'text', text: 'repeat this' }],
        timestamp: 51
      }),
      message('tool-result-null', {
        role: 'tool',
        blocks: [{ type: 'tool-result', output: 'read complete' }],
        timestamp: null
      }),
      message('image-source-a', {
        role: 'user',
        blocks: [{ type: 'text', text: '[Image: source: /tmp/a.png]' }],
        timestamp: 20
      }),
      message('image-source-b', {
        role: 'user',
        blocks: [{ type: 'text', text: '[Image: source: /tmp/b.png]' }],
        timestamp: 21
      }),
      message('image-prompt', {
        role: 'user',
        blocks: [{ type: 'text', text: '[Image #1] [Image #2] compare these' }],
        timestamp: 22
      }),
      message('standalone-image', {
        role: 'user',
        blocks: [{ type: 'text', text: '[Image: source: /tmp/standalone.png]' }],
        timestamp: 23
      }),
      message('tool-call', {
        blocks: [{ type: 'tool-call', name: 'read', input: { path: 'AGENTS.md' } }],
        timestamp: 30
      }),
      message('skill-envelope', {
        role: 'user',
        blocks: [
          {
            type: 'text',
            text: '<command-name>/plugin:review</command-name>\n<command-args>focus</command-args>'
          }
        ],
        timestamp: 40
      }),
      message('same-prompt-1', {
        role: 'user',
        blocks: [{ type: 'text', text: 'repeat this' }],
        timestamp: 50
      })
    ]

    const out = expectLegacyMessageParity(transcript)

    expect(out.map((entry) => entry.id)).toEqual([
      'tool-result-null',
      'image-prompt',
      'standalone-image',
      'tool-call',
      'skill-envelope',
      'same-prompt-1',
      'same-prompt-2'
    ])
    expect(out.find((entry) => entry.id === 'image-prompt')?.blocks).toEqual([
      { type: 'image-ref', path: '/tmp/a.png' },
      { type: 'image-ref', path: '/tmp/b.png' },
      { type: 'text', text: 'compare these' }
    ])
    expect(out.find((entry) => entry.id === 'standalone-image')?.blocks).toEqual([
      { type: 'image-ref', path: '/tmp/standalone.png' }
    ])
    expect(out.find((entry) => entry.id === 'skill-envelope')?.blocks).toEqual([
      { type: 'text', text: '/review focus' }
    ])
  })

  it('preserves the preassembled array through every status-precedence path', () => {
    const messages = [message('answer', { timestamp: 10 })]
    const base = { messages, sessionId: 'session-1', agent: 'claude' as const }
    const sessions = [
      mergeNativeChatLiveSession({
        ...base,
        hookState: 'working',
        loading: true,
        transcriptLifecycle: { state: 'working', turnId: 'turn-1', timestamp: 9 }
      }),
      mergeNativeChatLiveSession({
        ...base,
        hookState: 'working',
        stateStartedAt: 9,
        transcriptLifecycle: { state: 'completed', turnId: 'turn-1', timestamp: 10 },
        hookHasWorkingSubagents: true
      }),
      mergeNativeChatLiveSession({
        ...base,
        hookState: 'working',
        stateStartedAt: 9,
        transcriptLifecycle: { state: 'interrupted', turnId: 'turn-1', timestamp: 10 },
        hookHasWorkingSubagents: true
      }),
      mergeNativeChatLiveSession({ ...base, hookState: null, loading: true }),
      mergeNativeChatLiveSession({
        ...base,
        hookState: 'working',
        loading: true,
        error: 'unreadable'
      })
    ]

    expect(sessions.map((session) => session.status)).toEqual([
      'working',
      'working',
      'ready',
      'loading',
      'error'
    ])
    for (const session of sessions) {
      expect(session.messages).toBe(messages)
    }
    expect(sessions.at(-1)?.error).toBe('unreadable')
  })

  it('matches the legacy rebuild across deterministic randomized transcripts', () => {
    for (let seed = 1; seed <= 512; seed += 1) {
      expectLegacyMessageParity(randomTranscript(seed))
    }
  })
})

function randomTranscript(seed: number): NativeChatMessage[] {
  const random = mulberry32(seed)
  const count = 1 + Math.floor(random() * 48)
  const messages: NativeChatMessage[] = []
  for (let index = 0; index < count; index += 1) {
    const priorIndex = index > 0 ? Math.floor(random() * index) : index
    const idIndex = index > 0 && random() < 0.12 ? priorIndex : index
    const timestamp = random() < 0.18 ? null : Math.floor(random() * 24)
    const kind = Math.floor(random() * 7)
    const entry = randomMessage(seed, index, idIndex, timestamp, kind)
    if (random() < 0.2) {
      entry.turnId = `turn-${seed}-${index}`
    }
    messages.push(entry)
  }
  return messages
}

function randomMessage(
  seed: number,
  index: number,
  idIndex: number,
  timestamp: number | null,
  kind: number
): NativeChatMessage {
  const id = `message-${seed}-${idIndex}`
  const source = (seed + index) % 4 === 0 ? ('scrape' as const) : ('transcript' as const)
  const base = { id, timestamp, source }
  switch (kind) {
    case 0:
      return { ...base, role: 'user', blocks: [{ type: 'text', text: ` prompt  ${index % 5} ` }] }
    case 1:
      return { ...base, role: 'assistant', blocks: [{ type: 'text', text: `answer ${index}` }] }
    case 2:
      return {
        ...base,
        role: 'assistant',
        blocks: [{ type: 'tool-call', name: 'read', input: { path: `${index}.txt` } }]
      }
    case 3:
      return {
        ...base,
        role: 'tool',
        blocks: [{ type: 'tool-result', output: `result ${index}`, isError: index % 5 === 0 }]
      }
    case 4:
      return {
        ...base,
        role: 'user',
        blocks: [{ type: 'text', text: `[Image: source: /tmp/${seed}-${index}.png]` }]
      }
    case 5:
      return {
        ...base,
        role: 'user',
        blocks: [{ type: 'text', text: `[Image #1] [Image #2] inspect ${index}` }]
      }
    default:
      return {
        ...base,
        role: 'user',
        blocks: [
          {
            type: 'text',
            text: `<command-name>/plugin:skill-${index % 3}</command-name>\n<command-args>arg ${index}</command-args>`
          }
        ]
      }
  }
}

function mulberry32(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let value = Math.imul(state ^ (state >>> 15), 1 | state)
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}
