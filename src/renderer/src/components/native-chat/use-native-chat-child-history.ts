import { useEffect, useRef } from 'react'
import { hasRecordedNativeChatChildAssignment } from '../../../../shared/native-chat-child-inputs'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { NativeChatOlderPageResult } from './native-chat-pagination'
import { nativeChatChildAgentId } from './native-chat-child-agent-id'

export function useNativeChatChildHistory(args: {
  scopeKey: string
  agentId?: string
  messages: readonly NativeChatMessage[]
  hasMore: boolean
  loading: boolean
  enabled: boolean
  generation?: number
  anchorKey?: string
  loadEarlier: () => Promise<NativeChatOlderPageResult>
}): void {
  const { enabled, hasMore, loading, loadEarlier } = args
  const attempted = useRef<string | null>(null)
  const head = args.messages[0]
  const agentId = args.agentId === undefined ? undefined : nativeChatChildAgentId(args.agentId)
  const found = hasRecordedNativeChatChildAssignment(args.messages, agentId)
  const anchor = JSON.stringify([
    args.scopeKey,
    args.generation,
    args.anchorKey ?? head?.journalPosition ?? head?.id
  ])
  useEffect(() => {
    if (!enabled || found || !hasMore || loading || attempted.current === anchor) {
      return
    }
    // Each older anchor gets one attempt; a refusal or unchanged page requires explicit retry.
    attempted.current = anchor
    void loadEarlier().catch(() => undefined)
  }, [anchor, enabled, hasMore, loading, loadEarlier, found])
}
