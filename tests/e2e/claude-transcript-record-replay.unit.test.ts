import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { mergeNativeChatMessages } from '../../src/shared/native-chat-merge'
import {
  pendingSendsAsMessages,
  prunePendingSends
} from '../../src/renderer/src/components/native-chat/native-chat-pending'
import { orderNativeChatMessages } from '../../src/renderer/src/components/native-chat/native-chat-message-grouping'
import { decodeClaudeTranscriptLine } from '../../src/main/native-chat/transcript-line-decoders-claude'
import { readNativeChatTranscript } from '../../src/main/native-chat/transcript-reader'
import { readNativeChatTranscriptTailFile } from '../../src/main/native-chat/transcript-tail-reader'
import { decodeTranscriptStream } from '../../src/main/native-chat/transcript-stream-lines'

const lines = [
  '{"type":"user","uuid":"u1","timestamp":"2026-06-01T10:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"start the long running task"}]}}',
  '{"type":"assistant","uuid":"a1","timestamp":"2026-06-01T10:00:03.000Z","message":{"content":[{"type":"text","text":"working through the first task now"}]}}',
  '{"type":"attachment","uuid":"q1","timestamp":"2026-06-01T10:00:02.000Z","attachment":{"type":"queued_command","prompt":"and check the config while you are at it","commandMode":"prompt"}}',
  '{"type":"assistant","uuid":"a2","timestamp":"2026-06-01T10:00:06.000Z","message":{"content":[{"type":"text","text":"both done"}]}}'
]
let root: string

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
})

describe('Claude admitted record replay', () => {
  it.each(['\n', '\r\n'])(
    'agrees across full, bounded, append and reconnect reads with %j lines',
    async (newline) => {
      root = await mkdtemp(join(tmpdir(), 'orca-claude-admission-'))
      const filePath = join(root, 'session.jsonl')
      const initial = lines.slice(0, 2).join(newline) + newline
      await writeFile(filePath, initial)
      const base = await readNativeChatTranscriptTailFile(filePath, 10, decodeClaudeTranscriptLine)
      const appended = lines.slice(2).join(newline) + newline
      await appendFile(filePath, appended)
      const incremental = await decodeTranscriptStream(
        Readable.from([Buffer.from(appended)]),
        filePath,
        Buffer.byteLength(initial),
        decodeClaudeTranscriptLine,
        false
      )
      const merged = mergeNativeChatMessages(base.messages, incremental.messages)
      const full = await readNativeChatTranscript('claude', 'synthetic', {
        filePath
      })
      expect(full).toEqual({ messages: merged })
      expect(merged.map((message) => message.id)).toEqual(['u1', 'a1', 'q1', 'a2'])
      expect(merged[2]?.timestamp).toBe(Date.parse('2026-06-01T10:00:02.000Z'))
      const tail = await readNativeChatTranscriptTailFile(filePath, 2, decodeClaudeTranscriptLine)
      expect(tail.messages.map((message) => message.id)).toEqual(['q1', 'a2'])
      const earlier = await readNativeChatTranscriptTailFile(
        filePath,
        2,
        decodeClaudeTranscriptLine,
        false,
        tail.beforeOffset
      )
      expect(mergeNativeChatMessages(earlier.messages, tail.messages)).toEqual(merged)
      expect(mergeNativeChatMessages(merged, tail.messages)).toEqual(merged)
      const pending = [
        {
          id: 'pending-q1',
          text: 'and check the config while you are at it',
          sentAt: Date.parse('2026-06-01T10:00:02.000Z'),
          afterMessageId: 'u1'
        }
      ]
      expect(pendingSendsAsMessages(pending, base.messages)).toHaveLength(1)
      expect(pendingSendsAsMessages(pending, merged)).toEqual([])
      expect(prunePendingSends(pending, merged)).toEqual([])
      // Timestamp ordering is independently owned downstream and remains out of scope.
      expect(orderNativeChatMessages(merged).map((message) => message.id)).toEqual([
        'u1',
        'q1',
        'a1',
        'a2'
      ])
    }
  )

  it('keeps fallback notice IDs stable between tail and full readers', async () => {
    root = await mkdtemp(join(tmpdir(), 'orca-claude-notice-'))
    const filePath = join(root, 'session.jsonl')
    await writeFile(
      filePath,
      `${JSON.stringify({
        type: 'system',
        subtype: 'future_notice',
        content: 'Please run /login'
      })}\n`
    )
    const full = await readNativeChatTranscript('claude', 'synthetic', {
      filePath
    })
    const tail = await readNativeChatTranscriptTailFile(filePath, 1, decodeClaudeTranscriptLine)
    expect(tail.messages).toHaveLength(1)
    expect(full).toEqual({ messages: tail.messages })
    expect(mergeNativeChatMessages(tail.messages, tail.messages)).toHaveLength(1)
  })
})
