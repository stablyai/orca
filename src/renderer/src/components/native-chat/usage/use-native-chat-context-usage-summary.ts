import { useMemo } from 'react'
import type { NativeChatStructuredComposerTransport } from '../composer/submit/native-chat-structured-composer-transport'
import {
  summarizeContextUsage,
  type NativeChatContextUsageSummary
} from '../../../../../shared/native-chat/native-chat-context-usage-summary'

/** The ring's input. A terminal-backed chat has no structured journal, so it shows no ring. */
export function useNativeChatContextUsageSummary(
  structuredTransport: NativeChatStructuredComposerTransport | undefined
): NativeChatContextUsageSummary | null {
  const usage = structuredTransport?.contextUsage ?? null
  return useMemo(() => (usage ? summarizeContextUsage(usage) : null), [usage])
}
