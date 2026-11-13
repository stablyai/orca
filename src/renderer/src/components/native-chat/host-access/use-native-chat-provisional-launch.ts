import { restorePersistedStructuredLaunchState } from '@/lib/agent-session/launch/structured-agent-session-launch-reload'
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { getStructuredAgentSessionLaunchSelection } from '../../../lib/agent-session/launch/structured-agent-session-launch-options'
import {
  useStructuredAgentSessionLaunchFailure,
  useStructuredAgentSessionLaunchLifecycle
} from '@/lib/agent-session/launch/structured-agent-session-launch-registry'
import {
  subscribeStructuredAgentLaunchStatus,
  getStructuredLaunchStateBySessionId
} from '@/lib/agent-session/launch/structured-agent-session-launch-state-store'
import {
  structuredAgentSessionLaunchHasRetainedInput,
  getStructuredAgentSessionLaunchResumes
} from '@/lib/agent-session/launch/structured-agent-session-launch-input'
import {
  relaunchFailedStructuredAgentSessionWithMessage,
  sendMessageToStartingStructuredAgentSession
} from '../../../lib/agent-session/launch/structured-agent-session-launch-message'
import {
  relaunchFailedStructuredAgentSessionForMessage,
  retryStructuredAgentSessionLaunch
} from '@/lib/agent-session/launch/structured-agent-session-launch'
import { toRuntimeWorktreeSelector } from '@/runtime/rpc/targets/runtime-worktree-selector'

export type StructuredAgentSessionLaunchView = {
  kind: 'new' | 'resume'
  /** The encoded selection the launch seeded, shown until the host names the model. */
  seedOptions?: Readonly<Record<string, string>>
  explicitOptions?: Readonly<Record<string, string>>
  /** Where the chat runs; its own config may replace the listed default. */
  worktree?: string
  /** Its paired server has not said what create seeds yet; picks wait for it. */
  seedPending?: true
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
  return useMemo(
    () =>
      intent.kind
        ? {
            kind: intent.kind,
            ...(selection?.seed ? { seedOptions: selection.seed } : {}),
            ...(seedPending ? { seedPending: true as const } : {}),
            ...(selection?.explicit ? { explicitOptions: selection.explicit } : {}),
            ...(worktreeId ? { worktree: toRuntimeWorktreeSelector(worktreeId) } : {})
          }
        : undefined,
    [intent.kind, selection?.seed, selection?.explicit, seedPending, worktreeId]
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
    if (worktreeId) {
      retryStructuredAgentSessionLaunch(worktreeId, sessionId)
    }
  }, [sessionId, worktreeId])
  const starting = lifecycle === 'pending' || (lifecycle === 'visibility-unknown' && !retainedInput)
  const sendThroughLaunch = useCallback(
    (
      text: string,
      requiresSession: boolean,
      send: () => boolean | 'queued'
    ): boolean | 'queued' => {
      if (starting) {
        // Attachments and skills are prepared against the live chat, so only plain text waits for it.
        return (
          !requiresSession &&
          !!worktreeId &&
          sendMessageToStartingStructuredAgentSession(worktreeId, sessionId, text) !== null
        )
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
    sendThroughLaunch,
    transportEnabled: retainedInput || lifecycle === null || lifecycle === 'published'
  }
}
