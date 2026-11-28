import { useAppStore } from '@/store'
import { useNativeChatPaneLifetimeEffect } from '../../../pane/ownership/native-chat-pane-lifetime'
import { subscribeRuntimeHostContactRegained } from '@/runtime/hosts/connections/runtime-host-contact-regained'
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { notifyStructuredAttentionView } from '@/attention/agent-subject-read-actions'
import { structuredAttentionReadObservation } from '../../attention/structured-attention-read-observation'
import type { RuntimeClientTarget } from '../../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { getStructuredAgentSessionReadOwner } from './structured-agent-session-read-owner'
import { nativeChatShowsPromptSuggestions } from '../../../../../../../shared/native-chat/settings/native-chat-appearance-settings'
import type { StructuredAgentSessionReadSnapshot } from './structured-agent-session-read-owner-contract'

function useReadOwnerSnapshot(
  sessionId: string,
  target: RuntimeClientTarget
): {
  owner: ReturnType<typeof getStructuredAgentSessionReadOwner>
  snapshot: StructuredAgentSessionReadSnapshot
} {
  const owner = useMemo(
    () => getStructuredAgentSessionReadOwner(sessionId, target),
    [sessionId, target]
  )
  useNativeChatPaneLifetimeEffect(useCallback(() => owner.retain(), [owner]))
  const snapshot = useSyncExternalStore(owner.subscribe, owner.getSnapshot, owner.getSnapshot)
  return { owner, snapshot }
}

export function useStructuredAgentSessionRead(args: {
  sessionId: string
  target: RuntimeClientTarget
  isVisible?: boolean
  isViewed?: boolean
  /** Draws reply and reasoning text (a transcript), so a shown window takes live text. */
  showsReplyText?: boolean
}) {
  const { sessionId, target, isVisible = true, showsReplyText = false } = args
  const { owner, snapshot } = useReadOwnerSnapshot(sessionId, target)
  const isViewed = args.isViewed ?? isVisible
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  const observationKey = structuredAttentionReadObservation(snapshot.state)
  const lastView = useRef<{ owner: typeof owner; observationKey: string } | null>(null)
  // Read at start; a change re-runs the read so the host learns whether this reader shows them.
  const showsPromptSuggestions = useAppStore((state) =>
    nativeChatShowsPromptSuggestions(state.settings)
  )

  useEffect(() => {
    if (isVisible) {
      return owner.activate({
        getState: useAppStore.getState,
        showsReplyText,
        subscribeRetryNow: (retry) =>
          environmentId ? subscribeRuntimeHostContactRegained(environmentId, retry) : () => {}
      })
    }
    return undefined
  }, [isVisible, owner, environmentId, showsPromptSuggestions, showsReplyText])
  useEffect(() => {
    const observedCursor = snapshot.state.cursor
    if (!isViewed) {
      lastView.current = null
      return
    }
    if (
      !observedCursor ||
      (lastView.current?.owner === owner && lastView.current.observationKey === observationKey)
    ) {
      return
    }
    lastView.current = { owner, observationKey }
    notifyStructuredAttentionView({
      sessionId,
      target,
      observedCursor: { ...observedCursor },
      observationKey
    })
  }, [isViewed, observationKey, owner, sessionId, snapshot.state.cursor, target])

  return {
    state: snapshot.state,
    readCurrent: snapshot.current,
    loadingOlder: snapshot.loadingOlder,
    olderHistoryGeneration: snapshot.olderHistoryGeneration,
    initialHistoryAutoLoad: snapshot.initialHistoryAutoLoad,
    loadOlder: owner.loadOlder,
    retainHistory: owner.retainHistory,
    trimHistory: owner.trimHistory,
    providerSession: snapshot.providerSession
  }
}
