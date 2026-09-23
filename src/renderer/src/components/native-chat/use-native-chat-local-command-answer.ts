import { useCallback, type Dispatch, type SetStateAction } from 'react'
import type { AgentType } from '../../../../shared/agent-status-types'
import { getNativeChatCommandReply } from '../../../../shared/native-chat-agent-profiles'
import { deriveNativeChatContextUsage } from '../../../../shared/native-chat-context-usage'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import { ompModelSelector } from '../../../../shared/omp-model-list-probe'
import { pushHistory, type HistoryState } from './native-chat-composer-state'
import {
  formatNativeChatContextUsageAnswer,
  formatNativeChatContextUsageUnreported
} from './native-chat-context-usage-answer'
import type { NativeChatPtySessionOptionsSurface } from './native-chat-pty-session-options'

/** The context window the host's model listing states for a model id, or null. */
export type NativeChatModelContextWindow = (modelId: string) => number | null

/** Answers a command the chat host owns over a terminal session, or null to send it. */
export type NativeChatLocalCommandAnswer = (
  command: string,
  contextWindowTokens: NativeChatModelContextWindow
) => string | null

/** OMP's `/context` paints a panel the chat never sees, so the host replies from the
 *  prompt size the last response reported, against the window of the model that
 *  served it. Null for any command whose catalog row is not composer-answered. */
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
    // Why: several providers share a bare model id; the listing keys by selector.
    const selector = ompModelSelector(message.provider, message.model)
    return selector ? args.contextWindowTokens(selector) : null
  })
  return formatNativeChatContextUsageAnswer(usage)
}

/** False when the agent has answered yet no answer names its model: a host that
 *  predates usage decoding, or a scraped view, will never report usage. */
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

/** The send paths' shared intercept: a composer-answered command is answered in
 *  place of reaching the PTY. Attachments stay armed for the next prompt. Returns
 *  false when the command must be sent. */
export function answerNativeChatCommandInComposer(args: {
  draft: string
  answerCommandLocally?: NativeChatLocalCommandAnswer
  sessionOptionsSurface: NativeChatPtySessionOptionsSurface | null
  onSlashCommand?: (command: string, output?: string) => void
  setHistory: Dispatch<SetStateAction<HistoryState>>
  setDraft: (value: string) => void
  setCaret: Dispatch<SetStateAction<number>>
  clearSkillOrigin: () => void
  setNotice: Dispatch<SetStateAction<string | null>>
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
  args.setHistory((previous) => pushHistory(previous, args.draft))
  args.setDraft('')
  args.setCaret(0)
  args.clearSkillOrigin()
  args.setNotice(null)
  return true
}
