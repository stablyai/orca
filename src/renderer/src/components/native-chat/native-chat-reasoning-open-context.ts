import { createContext, useContext } from 'react'
import { translate } from '@/i18n/i18n'
import { isNativeChatSubagentThinking } from '../../../../shared/native-chat-reasoning-row'
import type { NativeChatSubagentEntry } from '../../../../shared/native-chat-types'

/** The host's live "reasoning open" gate for the transcript: the session's own agent without an
 *  id, else that subagent. A context because roster entries draw deep inside message rows. */
export const NativeChatReasoningOpenContext = createContext<(agentId?: string) => boolean>(
  () => false
)

/** Whether a subagent shows "Thinking" now (`isNativeChatSubagentThinking`). */
export function useNativeChatSubagentThinking(): (
  agentId: string,
  entry: Pick<NativeChatSubagentEntry, 'state'> | undefined
) => boolean {
  const isReasoningOpen = useContext(NativeChatReasoningOpenContext)
  return (agentId, entry) => isNativeChatSubagentThinking(isReasoningOpen, agentId, entry)
}

/** The live turn's word for open reasoning, as a subagent's state text. */
export function nativeChatSubagentThinkingLabel(): string {
  return translate('components.native-chat.status.thinking', 'Thinking')
}
