import { describe, expect, it, vi } from 'vitest'
import { buildAgentSessionContinuationPrompt } from './agent-session-continuation'
import {
  AGENT_DRAFT_PASTE_CHUNK_MAX_BYTES,
  AGENT_DRAFT_PASTE_DIRECT_MAX_BYTES,
  AGENT_DRAFT_PASTE_MAX_BYTES,
  iterateAgentDraftPasteContentChunks,
  sendAgentDraftPasteContentNow
} from './agent-draft-paste-content'
import {
  launchPromptAsMessage,
  shouldPruneLaunchPrompt
} from '@/components/native-chat/native-chat-pending'
import type { NativeChatMessage } from '../../../shared/native-chat-types'

vi.mock('@/runtime/runtime-terminal-inspection', () => ({ sendRuntimePtyInputVerified: vi.fn() }))

describe('Windows launch prompt paste', () => {
  it('preserves the complete continuation so the transcript retires its launch echo', async () => {
    const text = buildAgentSessionContinuationPrompt(
      {
        sourceAgent: 'codex',
        sourceTitle: 'Review progress',
        sourceWorkingDirectory: 'C:\\work\\project',
        transcriptPath: 'C:\\sessions\\previous.jsonl',
        capturedText: '',
        lastAssistantMessage: 'Review remains unfinished.'
      },
      'focused'
    )!
    const write = vi.fn(async (_data: string) => true)
    expect(await sendAgentDraftPasteContentNow({}, 'pty-1', text, write, 'alt-enter')).toBe(true)
    const bytes = write.mock.calls.map(([data]) => data).join('')
    expect(bytes).toBe(text.replace(/\n/g, '\x1b\r'))
    const received = bytes.replaceAll('\x1b\r', '\n')
    const user: NativeChatMessage = {
      id: 'user-1',
      role: 'user',
      blocks: [{ type: 'text', text: received }],
      timestamp: 43,
      source: 'transcript'
    }
    const entry = { tabId: 'tab-1', agent: 'codex' as const, text, createdAt: 42 }
    expect(launchPromptAsMessage(entry, [user])).toBeNull()
    expect(shouldPruneLaunchPrompt(entry, [user])).toBe(false)
    expect(
      shouldPruneLaunchPrompt(entry, [
        user,
        {
          id: 'answer-1',
          role: 'assistant',
          blocks: [{ type: 'text', text: 'Continuing.' }],
          timestamp: 44,
          source: 'transcript'
        }
      ])
    ).toBe(true)
  })

  it.each(['alt-enter', 'csi-u'] as const)(
    'keeps %s newline sequences and Unicode atomic across chunks',
    async (mode) => {
      const text = `${'x'.repeat(AGENT_DRAFT_PASTE_CHUNK_MAX_BYTES - 1)}😀\r\n后续\r结束\n`.repeat(
        5
      )
      const newline = mode === 'alt-enter' ? '\x1b\r' : '\x1b[13;2u'
      const write = vi.fn(async (_data: string) => true)
      expect(await sendAgentDraftPasteContentNow({}, 'pty-1', text, write, mode)).toBe(true)
      const chunks = write.mock.calls.map(([data]) => data)
      expect(chunks.length).toBeGreaterThan(1)
      expect(chunks.join('')).toBe(text.replace(/\r\n|\r|\n/g, newline))
      for (const chunk of chunks) {
        expect(Buffer.byteLength(chunk)).toBeLessThanOrEqual(AGENT_DRAFT_PASTE_CHUNK_MAX_BYTES)
        expect(Buffer.from(chunk).toString()).toBe(chunk)
        expect(chunk.replaceAll(newline, '')).not.toContain('\x1b')
      }
    }
  )

  it('counts expanded newlines when deciding to chunk', async () => {
    const write = vi.fn(async (_data: string) => true)
    const text = '\n'.repeat(AGENT_DRAFT_PASTE_DIRECT_MAX_BYTES / 2 + 1)
    expect(await sendAgentDraftPasteContentNow({}, 'pty-1', text, write, 'alt-enter')).toBe(true)
    expect(write.mock.calls.length).toBeGreaterThan(1)
  })

  it('rejects an expanded payload over the limit before writing', async () => {
    const write = vi.fn(async (_data: string) => true)
    const text = '\n'.repeat(AGENT_DRAFT_PASTE_MAX_BYTES / 2 + 1)
    expect(await sendAgentDraftPasteContentNow({}, 'pty-1', text, write, 'alt-enter')).toBe(false)
    expect(write).not.toHaveBeenCalled()
  })

  it('sanitizes embedded escapes without adding bracketed paste markers', async () => {
    const write = vi.fn(async (_data: string) => true)
    expect(
      await sendAgentDraftPasteContentNow({}, 'pty-1', 'a\x1b[201~\nb', write, 'alt-enter')
    ).toBe(true)
    expect(write).toHaveBeenCalledWith('a\u241b[201~\x1b\rb')
    expect([...iterateAgentDraftPasteContentChunks('a\x1b[201~\nb', 4, 'alt-enter')].join('')).toBe(
      'a\u241b[201~\x1b\rb'
    )
  })

  it('stops after a rejected chunk without sending a closing frame', async () => {
    const write = vi.fn(async (_data: string) => false)
    const text = 'x'.repeat(AGENT_DRAFT_PASTE_DIRECT_MAX_BYTES + 1)
    expect(await sendAgentDraftPasteContentNow({}, 'pty-1', text, write, 'alt-enter')).toBe(false)
    expect(write).toHaveBeenCalledTimes(1)
  })
})
