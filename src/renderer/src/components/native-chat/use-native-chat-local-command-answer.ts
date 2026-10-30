import { useCallback, type Dispatch, type SetStateAction } from 'react'
import type { AgentType } from '../../../../shared/agent-status-types'
import { getNativeChatCommandReply } from '../../../../shared/native-chat-agent-profiles'
import { deriveNativeChatContextUsage } from '../../../../shared/native-chat/native-chat-context-usage'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { ompModelSelector } from '../../../../shared/omp-model-list-probe'
import {
  formatNativeChatContextUsageAnswer,
  formatNativeChatContextUsageUnreported
} from './native-chat-context-usage-answer'
import type { NativeChatPtySessionOptionsSurface } from '../../../../shared/native-chat-pty-session-options'

export type NativeChatModelContextWindow = (modelId: string) => number | null

export type NativeChatLocalCommandAnswer = (
  command: string,
  contextWindowTokens: NativeChatModelContextWindow
) => string | null

/** OMP /context draws outside chat; answer composer-owned commands using the last response’s prompt size and serving model. */
export function answerNativeChatLocalCommand(args: {
  agent: AgentType
  command: string
  messages: readonly NativeChatMessage[]
  contextWindowTokens: NativeChatModelContextWindow
}): string | null {
  const name = /^\/(\S+)/.exec(args.command)?.[1]
  if (name !== 'context' || getNativeChatCommandReply(args.agent, name) !== 'composer') {
    return null
  }
  if (!sessionReportsUsage(args.messages)) {
    return formatNativeChatContextUsageUnreported()
  }
  const usage = deriveNativeChatContextUsage(args.messages, (message) => {
    // Providers may share bare model IDs; use the provider-qualified selector.
    const selector = ompModelSelector(message.provider, message.model)
    return selector ? args.contextWindowTokens(selector) : null
  })
  return formatNativeChatContextUsageAnswer(usage)
}

/** An answered session with no model evidence cannot report usage (older hosts or scraped views). */
function sessionReportsUsage(messages: readonly NativeChatMessage[]): boolean {
  let answered = false
  for (const message of messages) {
    if (message.role !== 'assistant' || message.source === 'hook') {
      continue
    }
    if (message.model !== undefined) {
      return true
    }
    answered = true
  }
  return !answered
}

export function useNativeChatLocalCommandAnswer(
  agent: AgentType,
  { messages }: { messages: readonly NativeChatMessage[] }
): NativeChatLocalCommandAnswer {
  return useCallback(
    (command, contextWindowTokens) =>
      answerNativeChatLocalCommand({ agent, command, messages, contextWindowTokens }),
    [agent, messages]
  )
}

/** Intercept composer-owned commands before PTY delivery; keep attachments armed and return false for commands to send. */
export function answerNativeChatCommandInComposer(args: {
  draft: string
  answerCommandLocally?: NativeChatLocalCommandAnswer
  sessionOptionsSurface: NativeChatPtySessionOptionsSurface | null
  onSlashCommand?: (command: string, output?: string) => void
  onSubmitted?: () => void
  setDraft: (value: string) => void
  setCaret: Dispatch<SetStateAction<number>>
  clearSkillOrigin: () => void
  setNotice: (notice: string | null) => void
}): boolean {
  const command = args.draft.trim()
  const answer =
    args.answerCommandLocally?.(
      command,
      (modelId) => args.sessionOptionsSurface?.contextWindowTokens(modelId) ?? null
    ) ?? null
  if (answer === null) {
    return false
  }
  args.onSlashCommand?.(command, answer)
  args.onSubmitted?.()
  args.setDraft('')
  args.setCaret(0)
  args.clearSkillOrigin()
  args.setNotice(null)
  return true
}
