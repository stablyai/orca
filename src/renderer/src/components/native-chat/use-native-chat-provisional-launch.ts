import { resumeHostLaunchPreparation } from '@/lib/agent-session/launch/structured-agent-session-host-launch-release'
import { restorePersistedStructuredLaunchState } from '@/lib/agent-session/launch/structured-agent-session-launch-reload'
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { getStructuredAgentSessionLaunchSelection } from '../../lib/agent-session/launch/structured-agent-session-launch-options'
import {
  subscribeStructuredAgentLaunchStatus,
  structuredAgentSessionLaunchHasRetainedInput,
  getStructuredLaunchStateBySessionId,
  getStructuredAgentSessionLaunchResumes,
  useStructuredAgentSessionLaunchFailure,
  useStructuredAgentSessionLaunchLifecycle
} from '@/lib/agent-session/launch/structured-agent-session-launch-registry'
import { relaunchFailedStructuredAgentSessionWithMessage } from '../../lib/agent-session/launch/structured-agent-session-launch-message'
import {
  relaunchFailedStructuredAgentSessionForMessage,
  retryStructuredAgentSessionLaunch
} from '@/lib/agent-session/launch/structured-agent-session-launch'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'
import { useNativeChatHeldOpeningEdit } from './use-native-chat-held-opening-edit'

export type StructuredAgentSessionLaunchView = {
  kind: 'new' | 'resume'
  /** The encoded selection the launch seeded, shown until the host names the model. */
  seedOptions?: Readonly<Record<string, string>>
  explicitOptions?: Readonly<Record<string, string>>
  /** Where the chat runs; its own config may replace the listed default. */
  worktree?: string
  /** Its paired server has not said what create seeds yet; picks wait for it. */
  seedPending?: true
  /** A host launch that takes its first turn after Setup: `editing` while picks still change that
   *  turn, `submitted` once it was handed over, after which a pick is for the next turn. */
  firstTurn?: 'editing' | 'submitted'
}

function readFirstTurnPhase(sessionId: string): 'editing' | 'submitted' | undefined {
  return getStructuredLaunchStateBySessionId(sessionId)?.intent.hostLaunch?.firstTurn?.phase
}

function useLaunchView(
  sessionId: string,
  worktreeId: string | null | undefined,
  launching: boolean
): StructuredAgentSessionLaunchView | undefined {
  const owner = useMemo(() => {
    let snapshot = getStructuredAgentSessionLaunchSelection(sessionId)
    const read = () => {
      const current = getStructuredAgentSessionLaunchSelection(sessionId)
      if (current) {
        snapshot = current
      } else if (snapshot && !snapshot.seedPending) {
        snapshot = { seed: snapshot.seed, seedPending: true }
      }
      return snapshot
    }
    return {
      read,
      subscribe: (notify: () => void) =>
        subscribeStructuredAgentLaunchStatus(() => {
          // Capture accepted picks even if retirement precedes React rendering.
          read()
          notify()
        })
    }
  }, [sessionId])
  const selection = useSyncExternalStore(owner.subscribe, owner.read, () => null)
  const [intent, setIntent] = useState<{
    sessionId: string
    kind: StructuredAgentSessionLaunchView['kind'] | null
  }>(() => ({
    sessionId,
    kind: launching ? (getStructuredAgentSessionLaunchResumes(sessionId) ? 'resume' : 'new') : null
  }))
  if (intent.sessionId !== sessionId) {
    setIntent({
      sessionId,
      kind: launching
        ? getStructuredAgentSessionLaunchResumes(sessionId)
          ? 'resume'
          : 'new'
        : null
    })
  }
  const seedPending = launching && (!selection || selection.seedPending === true)
  const firstTurn = useSyncExternalStore(
    subscribeStructuredAgentLaunchStatus,
    () => (launching ? readFirstTurnPhase(sessionId) : undefined),
    () => undefined
  )
  return useMemo(
    () =>
      intent.kind
        ? {
            kind: intent.kind,
            ...(selection?.seed ? { seedOptions: selection.seed } : {}),
            ...(seedPending ? { seedPending: true as const } : {}),
            ...(selection?.explicit ? { explicitOptions: selection.explicit } : {}),
            ...(worktreeId ? { worktree: toRuntimeWorktreeSelector(worktreeId) } : {}),
            ...(firstTurn ? { firstTurn } : {})
          }
        : undefined,
    [intent.kind, selection?.seed, selection?.explicit, seedPending, worktreeId, firstTurn]
  )
}

export function useNativeChatProvisionalLaunch(
  worktreeId: string | null | undefined,
  sessionId: string
) {
  const lifecycle = useStructuredAgentSessionLaunchLifecycle(worktreeId ?? '', sessionId)
  const retainedInput = structuredAgentSessionLaunchHasRetainedInput(worktreeId ?? '', sessionId)
  useEffect(() => {
    if (worktreeId && retainedInput && !getStructuredLaunchStateBySessionId(sessionId)) {
      restorePersistedStructuredLaunchState(worktreeId, sessionId)
    }
  }, [worktreeId, sessionId, retainedInput])
  const failure = useStructuredAgentSessionLaunchFailure(worktreeId ?? '', sessionId)
  const launch = useLaunchView(sessionId, worktreeId, lifecycle !== null && !retainedInput)
  const retry = useCallback(() => {
    // A held launch whose message's files could not reach its host prepares them again, under it.
    if (worktreeId && !resumeHostLaunchPreparation(worktreeId, sessionId)) {
      retryStructuredAgentSessionLaunch(worktreeId, sessionId)
    }
  }, [sessionId, worktreeId])
  const openingEdit = useNativeChatHeldOpeningEdit(worktreeId, sessionId, lifecycle === 'failed')
  const starting = lifecycle === 'pending' || (lifecycle === 'visibility-unknown' && !retainedInput)
  const sendThroughLaunch = useCallback(
    (
      text: string,
      requiresSession: boolean,
      send: () => boolean | 'queued'
    ): boolean | 'queued' => {
      if (starting) {
        return false
      }
      if (lifecycle !== 'failed' || !worktreeId) {
        return send()
      }
      if (!requiresSession && text.trim()) {
        return relaunchFailedStructuredAgentSessionWithMessage(worktreeId, sessionId, text) !== null
      }
      relaunchFailedStructuredAgentSessionForMessage(worktreeId, sessionId)
      return false
    },
    [lifecycle, sessionId, starting, worktreeId]
  )
  return {
    lifecycle,
    launch,
    failure,
    retry,
    starting,
    /** The first turn went to the host after Setup; picks now are for the next turn. */
    firstTurnSubmitted: launch?.firstTurn === 'submitted',
    sendThroughLaunch,
    /** A held opening whose files could not reach its host: Edit, or the edit while open. */
    editOpening: openingEdit.notice,
    openingEdit: openingEdit.editing,
    transportEnabled: retainedInput || lifecycle === null || lifecycle === 'published'
  }
}
