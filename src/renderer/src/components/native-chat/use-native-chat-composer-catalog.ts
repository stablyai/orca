import { useMemo } from 'react'
import type { AgentType } from '../../../../shared/agent-status-types'
import {
  nativeChatComposerCatalog,
  type NativeChatComposerCatalog
} from '../../../../shared/native-chat-composer-catalog'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'

export type { NativeChatComposerCatalog }

/** What the `/` menu offers — the shared pure selection, memoized per inputs. */
export function useNativeChatComposerCatalog(
  agent: AgentType,
  structuredTransport?: NativeChatStructuredComposerTransport
): NativeChatComposerCatalog {
  const structured = Boolean(structuredTransport)
  const reported = structuredTransport?.sessionCommands
  const conversationCommands = structuredTransport?.conversationCommands
  return useMemo(
    () =>
      nativeChatComposerCatalog(
        agent,
        structured ? { sessionCommands: reported, conversationCommands } : undefined
      ),
    [agent, conversationCommands, reported, structured]
  )
}
