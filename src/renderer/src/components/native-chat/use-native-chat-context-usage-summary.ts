import { useMemo } from 'react'
import type { NativeChatStructuredComposerTransport } from './native-chat-composer-types'
import {
  summarizeContextUsage,
  type NativeChatContextUsageSummary
} from './native-chat-context-usage-summary'

/** The ring's input. A terminal-backed chat has no structured journal, so it shows no ring. */
export function useNativeChatContextUsageSummary(
  structuredTransport: NativeChatStructuredComposerTransport | undefined
): NativeChatContextUsageSummary | null {
  const usage = structuredTransport?.contextUsage ?? null
  return useMemo(() => (usage ? summarizeContextUsage(usage) : null), [usage])
}
