import { readFileSync, statSync } from 'node:fs'
import type { AgentMessageThroughput } from '../agent-throughput-types'

// Why: a chat file is one JSON document, so it must be read whole; skip runaway sessions instead
// of parsing tens of megabytes on every hook.
export const GEMINI_CHAT_MAX_BYTES = 32 * 1024 * 1024

function readObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function readCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function readTimestamp(value: unknown): number {
  return typeof value === 'string' ? Date.parse(value) : Number.NaN
}

/**
 * Newest Gemini CLI message with token usage, timed from the message before it. Gemini writes
 * one message per model call; tool calls run between consecutive `gemini` messages.
 */
export function measureLastGeminiMessage(
  messages: readonly unknown[]
): AgentMessageThroughput | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = readObject(messages[index])
    if (!message || message.type !== 'gemini') {
      continue
    }
    const tokens = readObject(message.tokens)
    const outputTokens = readCount(tokens?.output) + readCount(tokens?.thoughts)
    const completedAt = readTimestamp(message.timestamp)
    if (!tokens || outputTokens <= 0 || !Number.isFinite(completedAt)) {
      continue
    }
    for (let previous = index - 1; previous >= 0; previous -= 1) {
      const startedAt = readTimestamp(readObject(messages[previous])?.timestamp)
      if (!Number.isFinite(startedAt)) {
        continue
      }
      const generationMs = completedAt - startedAt
      if (!(generationMs > 0)) {
        return undefined
      }
      return {
        messageId:
          typeof message.id === 'string' && message.id ? message.id : `gemini:${completedAt}`,
        model: typeof message.model === 'string' && message.model ? message.model : null,
        outputTokens,
        generationMs,
        completedAt
      }
    }
    return undefined
  }
  return undefined
}

/** Throughput of the newest completed message in a Gemini CLI chat transcript (JSON). */
export function readLastGeminiMessageThroughput(
  transcriptPath: string
): AgentMessageThroughput | undefined {
  let messages: unknown
  try {
    if (statSync(transcriptPath).size > GEMINI_CHAT_MAX_BYTES) {
      return undefined
    }
    messages = readObject(JSON.parse(readFileSync(transcriptPath, 'utf8')))?.messages
  } catch {
    return undefined
  }
  return Array.isArray(messages) ? measureLastGeminiMessage(messages) : undefined
}
