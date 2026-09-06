import { useCallback, useMemo, useState } from 'react'
import {
  stageNativeChatProviderContinuation,
  beginNativeChatProviderSwitch,
  isNativeChatProviderSwitching,
  bindNativeChatProviderContinuation,
  useNativeChatProviderContinuation,
  withNativeChatProviderHistory
} from './native-chat-provider-continuation'
import type { NativeChatSwitchProvider } from './use-native-chat-provider-models'
import type { NativeChatLiveSession } from './use-native-chat-live-session'
import { readPendingSendCache } from './native-chat-pending'

export function useNativeChatProviderHandoff(args: {
  liveSession: NativeChatLiveSession
  paneKey: string
  agent: string
  targetPtyId: string | null
  transcriptPath: string | null
  onSwitchProvider?: NativeChatSwitchProvider
}) {
  const { liveSession, paneKey, agent, targetPtyId, transcriptPath, onSwitchProvider } = args
  const continuation = useNativeChatProviderContinuation(paneKey)
  const [switchingProvider, setSwitchingProvider] = useState(false)
  const messages = useMemo(
    () => withNativeChatProviderHistory(continuation, agent, liveSession.messages, targetPtyId),
    [continuation, agent, liveSession.messages, targetPtyId]
  )
  const session = useMemo(() => ({ ...liveSession, messages }), [liveSession, messages])
  const switchProvider = useCallback<NativeChatSwitchProvider>(
    async (nextAgent, model) => {
      if (
        !onSwitchProvider ||
        !targetPtyId ||
        isNativeChatProviderSwitching(paneKey) ||
        liveSession.status === 'working' ||
        readPendingSendCache({ paneKey, agent }).length > 0
      ) {
        throw new Error('Wait for the current message before switching providers.')
      }
      const finishSwitching = beginNativeChatProviderSwitch(paneKey)
      setSwitchingProvider(true)
      let rollback: (() => void) | undefined
      try {
        rollback = stageNativeChatProviderContinuation({
          paneKey,
          sourcePtyId: targetPtyId,
          agent: nextAgent,
          messages: session.messages,
          transcriptPath
        })
        const replacementPtyId = await onSwitchProvider(nextAgent, model)
        if (replacementPtyId) {
          bindNativeChatProviderContinuation(paneKey, targetPtyId, replacementPtyId)
        }
      } catch (error) {
        rollback?.()
        throw error
      } finally {
        finishSwitching()
        setSwitchingProvider(false)
      }
    },
    [
      onSwitchProvider,
      targetPtyId,
      liveSession.status,
      paneKey,
      agent,
      session.messages,
      transcriptPath
    ]
  )
  return { session, switchProvider, switchingProvider, hasProviderHistory: continuation !== null }
}
