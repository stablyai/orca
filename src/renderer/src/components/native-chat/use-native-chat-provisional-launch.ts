import { useCallback, useMemo, useState } from 'react'
import {
  getStructuredAgentSessionLaunchLifecycle,
  getStructuredAgentSessionLaunchResumes,
  retryStructuredAgentSessionLaunch,
  useStructuredAgentSessionLaunchFailureReason,
  useStructuredAgentSessionLaunchLifecycle,
  useStructuredAgentSessionLaunchSelection
} from '@/lib/structured-agent-session-launch'
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
  const failureReason = useStructuredAgentSessionLaunchFailureReason(worktreeId ?? '', sessionId)
  const launch = useLatchedLaunchView(sessionId, worktreeId, lifecycle !== null)
  const retry = useCallback(() => {
    if (worktreeId) {
      retryStructuredAgentSessionLaunch(worktreeId, sessionId)
    }
  }, [sessionId, worktreeId])
  // A send into a start that never published relaunches it; the queued message goes out on publish.
  const sendThroughRelaunch = useCallback(
    (send: () => boolean): boolean => {
      const accepted = send()
      if (
        accepted &&
        worktreeId &&
        getStructuredAgentSessionLaunchLifecycle(worktreeId, sessionId) === 'failed'
      ) {
        retryStructuredAgentSessionLaunch(worktreeId, sessionId)
      }
      return accepted
    },
    [sessionId, worktreeId]
  )
  return {
    lifecycle,
    launch,
    failureReason,
    retry,
    sendThroughRelaunch,
    transportEnabled: lifecycle === null || lifecycle === 'published'
  }
}
