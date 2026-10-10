import { useMemo } from 'react'
import type { AgentType } from '../../../../shared/agent-status-types'
import { getVerifiedNativeChatCommands } from '../../../../shared/native-chat-agent-profiles'
import {
  nativeChatComposerCatalog,
  type NativeChatComposerCatalog
} from '../../../../shared/native-chat-composer-catalog'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'

export type { NativeChatComposerCatalog }

/** Memoized on the transport's catalog inputs, not the transport object, which
 *  is rebuilt on every streamed frame. */
export function useNativeChatComposerCatalog(
  agent: AgentType,
  structuredTransport?: NativeChatStructuredComposerTransport
): NativeChatComposerCatalog {
  const structured = Boolean(structuredTransport)
  const sessionCommands = structuredTransport?.sessionCommands
  const conversationCommands = structuredTransport?.conversationCommands
  return useMemo(
    () =>
      nativeChatComposerCatalog(
        agent,
        getVerifiedNativeChatCommands(agent),
        structured ? { sessionCommands, conversationCommands } : undefined
      ),
    [agent, conversationCommands, sessionCommands, structured]
  )
}
