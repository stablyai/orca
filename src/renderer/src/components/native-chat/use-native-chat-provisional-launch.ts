import { useCallback, useMemo, useState } from 'react'
import {
  getStructuredAgentSessionLaunchResumes,
  relaunchFailedStructuredAgentSessionForMessage,
  retryStructuredAgentSessionLaunch,
  useStructuredAgentSessionLaunchFailure,
  useStructuredAgentSessionLaunchLifecycle,
  useStructuredAgentSessionLaunchSelection
} from '@/lib/structured-agent-session-launch'
import { relaunchFailedStructuredAgentSessionWithMessage } from '@/lib/structured-agent-session-launch-message'
import { toRuntimeWorktreeSelector } from '@/runtime/runtime-worktree-selector'

/** A chat this view launched: a new conversation, or one resumed from history. */
export type StructuredAgentSessionLaunchView = {
  kind: 'new' | 'resume'
  /** The encoded selection the launch seeded, shown until the host names the model. */
  seedOptions?: Readonly<Record<string, string>>
  /** Picks the launch holds and applies before it publishes. */
  heldOptions: Readonly<Record<string, string>>
  /** Where the chat runs; its own config may replace the listed default. */
  worktree?: string
}

const NO_HELD_OPTIONS: Readonly<Record<string, string>> = {}

type LatchedLaunch = {
  kind: StructuredAgentSessionLaunchView['kind']
  seed: Readonly<Record<string, string>> | undefined
}

/** The launch this view started, latched: its record is deleted on publish, and a reopened chat
 *  runs its own options. The seed follows the launch while it lives (a retry or accepted pick). */
function useLatchedLaunchView(
  sessionId: string,
  worktreeId: string | null | undefined,
  launching: boolean
): StructuredAgentSessionLaunchView | undefined {
  const selection = useStructuredAgentSessionLaunchSelection(sessionId)
  const [latched, setLatched] = useState<LatchedLaunch | null>(() =>
    launching
      ? {
          kind: getStructuredAgentSessionLaunchResumes(sessionId) ? 'resume' : 'new',
          seed: selection?.seed
        }
      : null
  )
  if (latched && selection && selection.seed !== latched.seed) {
    setLatched({ kind: latched.kind, seed: selection.seed })
  }
  const held = selection?.held ?? NO_HELD_OPTIONS
  return useMemo(
    () =>
      latched
        ? {
            kind: latched.kind,
            ...(latched.seed ? { seedOptions: latched.seed } : {}),
            heldOptions: held,
            ...(worktreeId ? { worktree: toRuntimeWorktreeSelector(worktreeId) } : {})
          }
        : undefined,
    [held, latched, worktreeId]
  )
}

export function useNativeChatProvisionalLaunch(
  worktreeId: string | null | undefined,
  sessionId: string
) {
  const lifecycle = useStructuredAgentSessionLaunchLifecycle(worktreeId ?? '', sessionId)
  const failure = useStructuredAgentSessionLaunchFailure(worktreeId ?? '', sessionId)
  const launch = useLatchedLaunchView(sessionId, worktreeId, lifecycle !== null)
  const retry = useCallback(() => {
    if (worktreeId) {
      retryStructuredAgentSessionLaunch(worktreeId, sessionId)
    }
  }, [sessionId, worktreeId])
  // While the chat starts it takes no send, so Send stays off and the text stays in the box.
  const starting = lifecycle === 'pending' || lifecycle === 'visibility-unknown'
  const sendThroughLaunch = useCallback(
    (text: string, withImages: boolean, send: () => boolean | 'queued'): boolean | 'queued' => {
      if (starting) {
        return false
      }
      if (lifecycle !== 'failed' || !worktreeId) {
        return send()
      }
      // A failed start restarts, and a text message goes as the restart's first message.
      if (!withImages && text.trim()) {
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
    transportEnabled: lifecycle === null || lifecycle === 'published'
  }
}
