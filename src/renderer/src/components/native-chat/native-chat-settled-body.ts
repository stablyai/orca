import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from 'react'
import {
  receiptSettledBodySource,
  type AgentSessionSettledBodyOwner
} from '../../../../shared/agent-session-settled-body-reader'
import type { NativeChatResolvedPrompt } from '../../../../shared/native-chat-resolution-receipt'

export const NativeChatSettledBodyContext = createContext<AgentSessionSettledBodyOwner | null>(null)
const unavailable = { status: 'error' } as const
export function useNativeChatSettledBody(body: NativeChatResolvedPrompt) {
  const owner = useContext(NativeChatSettledBodyContext)
  const source = useMemo(() => receiptSettledBodySource(owner, body), [owner, body])
  return useSyncExternalStore(
    useCallback(
      (listener) => (source && owner ? owner.reader.subscribe(source, listener) : () => {}),
      [owner, source]
    ),
    useCallback(
      () => (source && owner ? owner.reader.getSnapshot(source) : unavailable),
      [owner, source]
    )
  )
}
