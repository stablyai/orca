import type { AgentJournalRenderItem } from './agent-session-journal-types'
import type { AgentSessionLatestTurn } from './agent-session-wire'
import { isRootAgentJournalItem } from './agent-session-journal-producer'
import type { NativeChatMessage } from './native-chat-types'

export const NEXT_PROMPTS_FENCE = 'orca-next-prompts'
const MAX_PROMPT_LENGTH = 500
const MAX_SUGGESTIONS = 3

export type NativeChatNextPrompts = { text: string; prompts: string[] }

export function parseNativeChatNextPrompts(text: string): NativeChatNextPrompts {
  // 只识别回复末尾独立的完整区块，不把嵌套代码示例变成操作建议。
  const lines = text.split('\n')
  let fence: string | null = null
  let start = -1
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const match = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line)
    if (!match) {
      continue
    }
    const marker = match[2]
    if (fence === null) {
      fence = marker
      start = match[3].trim() === NEXT_PROMPTS_FENCE ? i : -1
    } else if (marker[0] === fence[0] && marker.length >= fence.length && !match[3].trim()) {
      fence = null
      if (start < 0 || lines.slice(i + 1).some((tail) => tail.trim())) {
        continue
      }
      try {
        const payload = lines.slice(start + 1, i).join('\n')
        if (payload.length > 12_000) {
          break
        }
        const values: unknown = JSON.parse(payload)
        if (!Array.isArray(values) || values.length > MAX_SUGGESTIONS) {
          break
        }
        const prompts: string[] = []
        for (const value of values) {
          if (typeof value !== 'string') {
            return { text, prompts: [] }
          }
          const prompt = value.trim()
          if (
            !prompt ||
            prompt.length > MAX_PROMPT_LENGTH ||
            Array.from(prompt).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
          ) {
            return { text, prompts: [] }
          }
          if (!prompts.includes(prompt)) {
            prompts.push(prompt)
          }
        }
        if (prompts.length) {
          return { text: lines.slice(0, start).join('\n').trimEnd(), prompts }
        }
      } catch {
        break
      }
    }
  }
  return { text, prompts: [] }
}

export function latestNativeChatNextPrompts(
  messages: readonly NativeChatMessage[],
  items: readonly AgentJournalRenderItem[],
  latestTurn: AgentSessionLatestTurn | null | undefined
): string[] {
  // 只采用最新主会话消息；后来的用户输入、错误或工具消息都会使旧建议失效。
  const latest = messages.at(-1)
  if (
    !latest ||
    latest.role !== 'assistant' ||
    !isRootAgentJournalItem(latest) ||
    latest.shortened ||
    latest.state === 'running' ||
    latest.queued
  ) {
    return []
  }
  // Codex 助手行没有单独生命周期，以所属轮次的明确成功记录为准。
  const item = items.find((candidate) => candidate.itemId === latest.id)
  if (
    !latestTurn ||
    latestTurn.turn.state !== 'completed' ||
    latestTurn.turn.outcome !== 'success' ||
    !item ||
    !isRootAgentJournalItem(item) ||
    item.turnScope?.kind !== 'turn' ||
    item.turnScope.turnItemId !== latestTurn.itemId
  ) {
    return []
  }
  if (latest.blocks.some((block) => block.type !== 'text')) {
    return []
  }
  return parseNativeChatNextPrompts(
    latest.blocks.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n')
  ).prompts
}
