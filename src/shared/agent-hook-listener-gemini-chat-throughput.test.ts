import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GEMINI_CHAT_MAX_BYTES,
  measureLastGeminiMessage,
  readLastGeminiMessageThroughput
} from './agent-hook-listener/gemini-chat-throughput'

const BASE = Date.parse('2026-03-20T16:09:15.486Z')

function at(offsetMs: number): string {
  return new Date(BASE + offsetMs).toISOString()
}

function geminiMessage(args: {
  id: string
  offsetMs: number
  output?: number
  thoughts?: number
  withTokens?: boolean
}): Record<string, unknown> {
  return {
    id: args.id,
    timestamp: at(args.offsetMs),
    type: 'gemini',
    content: 'reply',
    thoughts: [],
    model: 'gemini-3-pro',
    ...(args.withTokens === false
      ? {}
      : {
          tokens: {
            input: 53_972,
            output: args.output ?? 71,
            cached: 33_890,
            thoughts: args.thoughts ?? 53,
            tool: 0,
            total: 54_096
          }
        })
  }
}

function userMessage(id: string, offsetMs: number): Record<string, unknown> {
  return { id, timestamp: at(offsetMs), type: 'user', content: 'go' }
}

const tmpDirs: string[] = []

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('gemini chat throughput', () => {
  it('measures the newest gemini message from the message before it', () => {
    const messages = [
      userMessage('u1', 0),
      geminiMessage({ id: 'g1', offsetMs: 8_241, output: 400, thoughts: 100 }),
      geminiMessage({ id: 'g2', offsetMs: 11_617, output: 71, thoughts: 53 })
    ]
    expect(measureLastGeminiMessage(messages)).toEqual({
      messageId: 'g2',
      model: 'gemini-3-pro',
      outputTokens: 124,
      generationMs: 3_376,
      completedAt: BASE + 11_617
    })
  })

  it('skips gemini messages without usage and gives up without an earlier timestamp', () => {
    expect(
      measureLastGeminiMessage([
        userMessage('u1', 0),
        geminiMessage({ id: 'g1', offsetMs: 2_000, output: 10 }),
        geminiMessage({ id: 'g2', offsetMs: 3_000, withTokens: false })
      ])
    ).toMatchObject({ messageId: 'g1', generationMs: 2_000 })
    expect(measureLastGeminiMessage([geminiMessage({ id: 'g1', offsetMs: 2_000 })])).toBe(undefined)
    expect(
      measureLastGeminiMessage([
        userMessage('u1', 5_000),
        geminiMessage({ id: 'g1', offsetMs: 5_000 })
      ])
    ).toBe(undefined)
    expect(measureLastGeminiMessage([null, 'text', { type: 'user' }])).toBe(undefined)
  })

  it('reads the chat file and refuses missing, malformed, or oversized files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orca-gemini-throughput-'))
    tmpDirs.push(dir)
    const chatPath = join(dir, 'session.json')
    writeFileSync(
      chatPath,
      JSON.stringify({
        sessionId: 's1',
        messages: [
          userMessage('u1', 0),
          geminiMessage({ id: 'g1', offsetMs: 1_500, output: 30, thoughts: 0 })
        ]
      })
    )
    expect(readLastGeminiMessageThroughput(chatPath)).toMatchObject({
      messageId: 'g1',
      outputTokens: 30,
      generationMs: 1_500
    })

    writeFileSync(chatPath, '{not json')
    expect(readLastGeminiMessageThroughput(chatPath)).toBe(undefined)
    expect(readLastGeminiMessageThroughput(join(dir, 'missing.json'))).toBe(undefined)
    expect(GEMINI_CHAT_MAX_BYTES).toBeGreaterThan(1024 * 1024)
  })
})
