import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { NativeChatMessage } from '../../src/shared/native-chat-types'
import { projectNativeChatTranscriptMessages } from '../../src/shared/native-chat-transcript-projection'
import { createNativeChatMerger, replaceList } from '../../src/shared/native-chat-merge'
import { readNativeChatTranscript } from '../../src/main/native-chat/transcript-reader'
import {
  readNativeChatTranscriptTail,
  subscribeNativeChatTranscript
} from '../../src/main/native-chat/transcript-watch'

// Claude timestamps queued prompts at send time but writes them after the tool result that absorbed them.
const PROMPT = {
  type: 'user',
  uuid: 'u-1',
  timestamp: '2026-06-01T10:00:00.000Z',
  message: { role: 'user', content: 'start the long task' }
}
const TOOL_CALL = {
  type: 'assistant',
  uuid: 'a-1',
  timestamp: '2026-06-01T10:00:01.000Z',
  message: {
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'sleep 30' } }]
  }
}
const TOOL_RESULT = {
  type: 'user',
  uuid: 'r-1',
  timestamp: '2026-06-01T10:00:30.000Z',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'done' }]
  }
}
const QUEUED = {
  type: 'attachment',
  uuid: 'q-1',
  parentUuid: 'r-1',
  timestamp: '2026-06-01T10:00:10.000Z',
  attachment: {
    type: 'queued_command',
    prompt: 'also check the config',
    commandMode: 'prompt',
    origin: { kind: 'human' },
    timestamp: '2026-06-01T10:00:10.000Z'
  }
}
const REPLY = {
  type: 'assistant',
  uuid: 'a-2',
  timestamp: '2026-06-01T10:00:35.000Z',
  message: {
    role: 'assistant',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: 'both done' }]
  }
}

const lines = (...records: object[]): string =>
  records.map((record) => `${JSON.stringify(record)}\n`).join('')

let roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
  roots = []
})

async function transcriptFile(content: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'orca-transcript-file-order-'))
  roots.push(root)
  const filePath = join(root, 'session.jsonl')
  await writeFile(filePath, content)
  return filePath
}

function expectPromptAfterToolRun(messages: NativeChatMessage[]): void {
  const rows = projectNativeChatTranscriptMessages(messages)
  expect(rows.map((row) => row.id)).toEqual(['u-1', 'a-1', 'q-1', 'a-2'])
  expect(rows[1]?.blocks.map((block) => block.type)).toEqual(['tool-call', 'tool-result'])
}

describe('transcript rows keep file order', () => {
  it.each([
    ['full read', (filePath: string) => readNativeChatTranscript('claude', 's', { filePath })],
    [
      'modern full read',
      (filePath: string) => readNativeChatTranscript('claude', 's', { filePath, sourceOrder: true })
    ],
    [
      'modern tail read',
      (filePath: string) =>
        readNativeChatTranscriptTail({
          agent: 'claude',
          sessionId: 's',
          filePath,
          limit: 40,
          sourceOrder: true
        })
    ],
    [
      'tail read',
      (filePath: string) =>
        readNativeChatTranscriptTail({ agent: 'claude', sessionId: 's', filePath, limit: 40 })
    ]
  ])(
    'places a mid-turn prompt after the tool result it was read with (%s)',
    async (_name, read) => {
      const filePath = await transcriptFile(lines(PROMPT, TOOL_CALL, TOOL_RESULT, QUEUED, REPLY))
      const result = await read(filePath)
      if (!('messages' in result)) {
        throw new Error(result.error)
      }
      expectPromptAfterToolRun(result.messages)
    }
  )

  it.each([false, true])(
    'places a mid-turn prompt appended after the initial snapshot (modern=%s)',
    async (sourceOrder) => {
      const filePath = await transcriptFile(lines(PROMPT, TOOL_CALL, TOOL_RESULT))
      const received: NativeChatMessage[] = []
      const subscription = await subscribeNativeChatTranscript({
        agent: 'claude',
        sessionId: 's',
        filePath,
        initialLimit: 40,
        sourceOrder,
        onInitialSnapshot: (messages) => received.push(...messages),
        onAppend: (messages) => received.push(...messages),
        debounceMs: 5,
        reconciliationIntervalMs: 20
      })
      try {
        await expect.poll(() => received.length).toBe(3)
        await appendFile(filePath, lines(QUEUED, REPLY))
        await expect.poll(() => received.length).toBe(5)
        expectPromptAfterToolRun(received)
      } finally {
        subscription.unsubscribe()
      }
    }
  )
})

describe('canonical source positions', () => {
  const record = (id: string, timestamp: string | null, text = id, role = 'assistant') => ({
    type: role,
    uuid: id,
    timestamp,
    message: { role, content: text }
  })
  const read = async (filePath: string, limit: number, beforeOffset?: number) => {
    const result = await readNativeChatTranscriptTail({
      agent: 'claude',
      sessionId: 's',
      filePath,
      limit,
      beforeOffset,
      sourceOrder: true
    })
    if (!('messages' in result)) {
      throw new Error(result.error)
    }
    return result
  }

  it('retains reader-produced tied image pages through prepend, append and reconnect into bubbles', async () => {
    const { applyMobileNativeChatStreamFrame } =
      await import('../../mobile/src/session/native-chat/mobile-native-chat-stream-frame')
    const { foldMobileNativeChatMessages } =
      await import('../../mobile/src/session/mobile-native-chat-render-data')
    const filePath = await transcriptFile(
      lines(
        ...[
          ['z-source', '[Image: source: /tmp/first.png]'],
          ['z-prompt', 'first [Image #1]'],
          ['a-source', '[Image: source: /tmp/second.png]'],
          ['a-prompt', 'second [Image #1]']
        ].map(([id, text]) => record(id, '2026-06-01T10:00:00Z', text, 'user'))
      )
    )
    const tail = await read(filePath, 1)
    const older = await read(filePath, 3, tail.beforeOffset)
    const merger = createNativeChatMerger()
    const frame = (
      type: 'snapshot' | 'appended',
      messages: NativeChatMessage[],
      replaceSnapshot = false
    ) =>
      applyMobileNativeChatStreamFrame({
        merger,
        frame: { type, messages, hasMore: true },
        limit: 100,
        replaceSnapshot
      })
    frame('snapshot', tail.messages, true)
    replaceList(merger, [...older.messages, ...merger.list])
    frame('appended', tail.messages)
    frame('snapshot', tail.messages)
    const bubbles = foldMobileNativeChatMessages(merger.list, 'claude')
    expect(bubbles.map((row) => row.id)).toEqual(['z-prompt', 'a-prompt'])
    expect(
      bubbles.map((row) =>
        row.blocks.filter((block) => block.type === 'image-ref').map((block) => block.path)
      )
    ).toEqual([['/tmp/first.png'], ['/tmp/second.png']])
  })

  it.each(['tied', 'backward', 'null'] as const)(
    'keeps absolute UTF8/CRLF positions across full, older and partial append reads (%s)',
    async (clock) => {
      const timestamps =
        clock === 'null'
          ? [null, null, null]
          : clock === 'tied'
            ? [PROMPT.timestamp, PROMPT.timestamp, PROMPT.timestamp]
            : [TOOL_RESULT.timestamp, QUEUED.timestamp, PROMPT.timestamp]
      const records = ['z-思考', 'm-emoji', 'a-answer'].map((id, i) =>
        record(id, timestamps[i], `${id} 🐳`)
      )
      const encoded = records.map((item) => `${JSON.stringify(item)}\r\n`)
      const filePath = await transcriptFile(encoded.join(''))
      const full = await readNativeChatTranscript('claude', 's', { filePath, sourceOrder: true })
      if (!('messages' in full)) {
        throw new Error(full.error)
      }
      expect(full.messages.map((row) => row.transcriptOrder)).toEqual([
        0,
        Buffer.byteLength(encoded[0]),
        Buffer.byteLength(encoded[0] + encoded[1])
      ])
      expect(full.messages.map((row) => row.timestamp)).toEqual(
        timestamps.map((time) => (time === null ? null : Date.parse(time)))
      )
      const tail = await read(filePath, 1)
      const older = await read(filePath, 2, tail.beforeOffset)
      expect([...older.messages, ...tail.messages]).toEqual(full.messages)
      const { createIncrementalTranscriptState, readIncrementalTranscriptMessages } =
        await import('../../src/main/native-chat/transcript-incremental-reader')
      const { decodeClaudeTranscriptLine } =
        await import('../../src/main/native-chat/transcript-line-decoders')
      const state = createIncrementalTranscriptState()
      state.offset = state.pendingStart = Buffer.byteLength(encoded[0])
      await writeFile(filePath, encoded[0] + encoded[1].slice(0, -2))
      expect(
        await readIncrementalTranscriptMessages(
          filePath,
          state,
          decodeClaudeTranscriptLine,
          undefined,
          undefined,
          undefined,
          undefined,
          true
        )
      ).toEqual([])
      await appendFile(filePath, `\r\n${encoded[2]}`)
      const appended = await readIncrementalTranscriptMessages(
        filePath,
        state,
        decodeClaudeTranscriptLine,
        undefined,
        undefined,
        undefined,
        undefined,
        true
      )
      expect(appended).toEqual(full.messages.slice(1))
      expect(projectNativeChatTranscriptMessages(full.messages).map((row) => row.id)).toEqual([
        'z-思考',
        'm-emoji',
        'a-answer'
      ])
    }
  )

  it.each([false, true])(
    'rejoins image units across page and append boundaries, source-first=%s',
    async (sourceFirst) => {
      const { createIncrementalAssembler, reset, applyAppends } =
        await import('../../src/renderer/src/components/native-chat/native-chat-incremental-assembler')
      const { prepareNativeChatLiveMessages } =
        await import('../../src/renderer/src/components/native-chat/native-chat-live-message-preparation')
      const { commandMarkersAsMessages } =
        await import('../../src/renderer/src/components/native-chat/native-chat-command-marker')
      const { createNativeChatMessageListProjection } =
        await import('../../src/renderer/src/components/native-chat/native-chat-message-list-projection')
      const pair = (id: string, path: string) => {
        const prompt = record(id, PROMPT.timestamp, `${id} [Image #1]`, 'user')
        const images = [1, 2].map((n) =>
          record(
            `${id}-image-${n}`,
            PROMPT.timestamp,
            `[Image: source: /tmp/${path}-${n}.png]`,
            'user'
          )
        )
        return sourceFirst ? [...images, prompt] : [prompt, ...images]
      }
      const records = [...pair('z-first', 'first'), ...pair('a-second', 'second')]
      const filePath = await transcriptFile(lines(...records))
      const page = await read(filePath, 2)
      const older = await read(filePath, 4, page.beforeOffset)
      const assembler = createIncrementalAssembler()
      reset(assembler, older.messages)
      for (const message of page.messages) {
        applyAppends(assembler, [message])
      }
      const marker = commandMarkersAsMessages([
        { id: 'between', command: '/compact', sentAt: Date.parse(PROMPT.timestamp) }
      ])
      const normalized = prepareNativeChatLiveMessages([...assembler.messages, ...marker], 'claude')
      const bubbles = createNativeChatMessageListProjection()(normalized).conversation.filter(
        (row) => row.role === 'user'
      )
      expect(bubbles.map((row) => row.id)).toEqual(['z-first', 'a-second'])
      expect(
        bubbles.map((row) =>
          row.blocks.filter((block) => block.type === 'image-ref').map((block) => block.path)
        )
      ).toEqual([
        ['/tmp/first-1.png', '/tmp/first-2.png'],
        ['/tmp/second-1.png', '/tmp/second-2.png']
      ])
      expect(assembler.byId.size).toBe(6)
      expect(bubbles.map((row) => row.transcriptOrder)).toEqual([
        older.messages.find((row) => row.id === 'z-first')?.transcriptOrder,
        [...older.messages, ...page.messages].find((row) => row.id === 'a-second')?.transcriptOrder
      ])
    }
  )

  it('keeps factual clocks for status, clear boundaries, mixed sources and optimistic tiers', async () => {
    const { mergeNativeChatLiveSession } =
      await import('../../src/shared/native-chat/native-chat-live-status')
    const { applyCommandMarkerBoundaries, commandMarkersAsMessages } =
      await import('../../src/renderer/src/components/native-chat/native-chat-command-marker')
    const { assembleNativeChatSession } =
      await import('../../src/renderer/src/components/native-chat/native-chat-session-assembler')
    const { NATIVE_CHAT_STREAMING_ID } =
      await import('../../src/shared/native-chat/native-chat-streaming')
    const filePath = await transcriptFile(
      lines(...Array.from({ length: 20 }, (_, i) => record(`old-${i}`, PROMPT.timestamp)))
    )
    const rows = (await read(filePath, 30)).messages
    const time = Date.parse(PROMPT.timestamp)
    expect(
      mergeNativeChatLiveSession({
        messages: rows,
        sessionId: 's',
        agent: 'grok',
        hookState: 'working',
        stateStartedAt: time + 10
      }).status
    ).toBe('working')
    expect(
      applyCommandMarkerBoundaries(rows, [{ id: 'clear', command: '/clear', sentAt: time + 10 }])
    ).toEqual([])
    const later = { ...rows[1], id: 'later', timestamp: time + 30 }
    const marker = commandMarkersAsMessages([
      { id: 'compact', command: '/compact', sentAt: time + 20 }
    ])[0]
    const echo = (
      id: string,
      timestamp: number | null,
      source: NativeChatMessage['source'] = 'scrape'
    ): NativeChatMessage => ({
      id,
      timestamp,
      source,
      role: 'user',
      blocks: [{ type: 'text', text: id }]
    })
    const transcript = [rows[0], later]
    const result = assembleNativeChatSession({
      agent: 'claude',
      sessionId: 's',
      sources: {
        transcript,
        hook: [echo('hook', time + 10, 'hook')],
        scrape: [
          marker,
          echo('null', null),
          echo('after', time + 40),
          echo(NATIVE_CHAT_STREAMING_ID, null),
          echo('pending:1', null),
          { ...echo('queued', null), queued: true },
          echo('launch-pending:1', null)
        ]
      }
    })
    expect(result.messages.map((row) => row.id)).toEqual([
      'null',
      'old-0',
      'hook',
      marker.id,
      'later',
      'after',
      NATIVE_CHAT_STREAMING_ID,
      'launch-pending:1',
      'pending:1',
      'queued'
    ])
    // Contradictory clocks preserve the canonical subsequence, with one explicit supplemental placement.
    expect(
      assembleNativeChatSession({
        agent: 'claude',
        sessionId: 's',
        sources: {
          transcript: [
            { ...rows[0], timestamp: 100 },
            { ...later, timestamp: 0 }
          ],
          hook: [echo('middle', 50, 'hook')]
        }
      }).messages.map((row) => row.id)
    ).toEqual(['middle', 'old-0', 'later'])
  })
})
