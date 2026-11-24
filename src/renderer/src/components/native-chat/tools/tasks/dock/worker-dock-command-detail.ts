// One dialog instance's exact command: an opening on the reader's credit, one bounded read, and a
// Copy that re-validates at the click. Anything unproven shows the preview with no Copy.

import type { RuntimeClientTarget } from '../../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { AgentSessionCommandDetailTuple } from '../../../../../../../shared/agent-session/background-tasks/agent-session-command-details'
import type { CommandDetailOpening } from '../../../../../../../shared/agent-session/view/live-read/command-detail-authority'
import { findStructuredAgentSessionReadOwner } from '../../../session/structured/read/structured-agent-session-read-owner-registry'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { getRuntimeEnvironmentRevision } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { getRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status/runtime-status-connection-generation'

export const WORKER_DOCK_COMMAND_DETAIL_METHOD = 'agentSession.backgroundCommand'
/** Local IPC has no timeout of its own; a reply after this is discarded. */
export const WORKER_DOCK_COMMAND_DETAIL_TIMEOUT_MS = 10_000

export type WorkerDockCommandDetail = {
  readonly opening: CommandDetailOpening
  /** The single read: the exact command, or null for fallback. Never called twice. */
  read: () => Promise<string | null>
  /** Validates at the click and writes the exact bytes; false (and no write) when refused. */
  copy: (write: (text: string) => Promise<void>) => Promise<boolean>
  close: () => void
}

class CommandDetailRefused extends Error {}

/** Target and runtime incarnation the opening was made under: a re-pair or reconnect ends it. */
function pinTarget(target: RuntimeClientTarget): {
  current: () => boolean
  pairingRevision: number | undefined
} {
  if (target.kind !== 'environment') {
    return { current: () => true, pairingRevision: undefined }
  }
  const { environmentId } = target
  const pairingRevision = getRuntimeEnvironmentRevision(environmentId)
  const connection = getRuntimeEnvironmentConnectionGeneration(environmentId)
  return {
    pairingRevision,
    current: () =>
      getRuntimeEnvironmentRevision(environmentId) === pairingRevision &&
      getRuntimeEnvironmentConnectionGeneration(environmentId) === connection
  }
}

function timeout(ms: number): Promise<'timeout'> {
  return new Promise((resolve) => setTimeout(() => resolve('timeout'), ms))
}

/** Null when this reader holds no current credit for the tuple: the dialog shows the preview. */
export function openWorkerDockCommandDetail(input: {
  sessionId: string
  target: RuntimeClientTarget
  tuple: AgentSessionCommandDetailTuple
  call?: typeof callRuntimeRpc
  timeoutMs?: number
}): WorkerDockCommandDetail | null {
  const { sessionId, target, tuple } = input
  const owner = findStructuredAgentSessionReadOwner(sessionId, target)
  if (!owner?.commandDetails) {
    return null
  }
  const pinned = pinTarget(target)
  const opening = owner.commandDetails.open(
    tuple,
    () => pinned.current() && findStructuredAgentSessionReadOwner(sessionId, target) === owner
  )
  if (!opening) {
    return null
  }
  const call = input.call ?? callRuntimeRpc
  let text: string | null = null
  let reading: Promise<string | null> | null = null
  const read = async (): Promise<string | null> => {
    // Dispatch check; a failed check latches the opening lost and notifies before refusing.
    if (!opening.check()) {
      return null
    }
    try {
      const reply = await Promise.race([
        call<{ command: unknown }>(
          target,
          WORKER_DOCK_COMMAND_DETAIL_METHOD,
          {
            sessionId,
            childWorkId: tuple.childWorkId,
            invocation: { invocationId: tuple.invocationId, generation: tuple.generation }
          },
          {
            timeoutMs: input.timeoutMs ?? WORKER_DOCK_COMMAND_DETAIL_TIMEOUT_MS,
            ...(pinned.pairingRevision !== undefined
              ? { expectedEnvironmentPairingRevision: pinned.pairingRevision }
              : {}),
            // After any compatibility await, before the request leaves.
            beforeSend: () => {
              if (!opening.check()) {
                throw new CommandDetailRefused()
              }
            }
          }
        ),
        timeout(input.timeoutMs ?? WORKER_DOCK_COMMAND_DETAIL_TIMEOUT_MS)
      ])
      // A late, refused or stale reply is discarded, never shown.
      if (reply === 'timeout' || !opening.check()) {
        return null
      }
      const command = reply.command
      if (typeof command !== 'string' || command.length === 0) {
        return null
      }
      text = command
      return command
    } catch {
      // Older hosts answer method-not-found; every failure is the approved fallback.
      return null
    }
  }
  return {
    opening,
    read: () => (reading ??= read()),
    copy: async (write) => {
      const exact = text
      // Checked immediately before the write, with the text the opening read, not props.
      if (exact === null || !opening.check()) {
        return false
      }
      await write(exact)
      return true
    },
    close: () => opening.close()
  }
}
