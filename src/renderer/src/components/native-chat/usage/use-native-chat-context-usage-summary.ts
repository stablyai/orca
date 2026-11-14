import { useMemo } from 'react'
import type { NativeChatStructuredComposerTransport } from '../composer/submit/native-chat-structured-composer-transport'
import {
  summarizeContextUsage,
  summarizeTranscriptContextUsage,
  type NativeChatContextUsageSummary
} from '../../../../../shared/native-chat/native-chat-context-usage-summary'
import type { NativeChatMessage } from '../../../../../shared/native-chat/native-chat-types'
import type { NativeChatPtySessionOptionsSurface } from '../../../../../shared/native-chat/input/native-chat-pty-session-options'
import { ompModelSelector } from '../../../../../shared/omp-model-list-probe'

/** Structured facts take precedence; terminal chats use their transcript's last measured response. */
export function useNativeChatContextUsageSummary(
  structuredTransport: NativeChatStructuredComposerTransport | undefined,
  terminal?: {
    agent: string
    messages?: readonly NativeChatMessage[]
    surface: NativeChatPtySessionOptionsSurface | null
  }
): NativeChatContextUsageSummary | null {
  const usage = structuredTransport?.contextUsage ?? null
  const structuredUsage = useMemo(() => (usage ? summarizeContextUsage(usage) : null), [usage])
  if (structuredTransport) {
    return structuredUsage
  }
  return terminal?.messages
    ? summarizeTranscriptContextUsage(terminal.messages, (message) => {
        const model =
          terminal.agent === 'omp'
            ? ompModelSelector(message.provider, message.model)
            : message.model
        return model ? (terminal.surface?.contextWindowTokens(model) ?? null) : null
      })
    : null
}
