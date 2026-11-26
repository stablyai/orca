// One dialog instance's exact command: an opening on the reader's credit, one bounded read, and a
// Copy that re-validates at the click. Anything unproven shows the preview with no Copy.

import type { RuntimeClientTarget } from '../../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { AgentSessionCommandDetailTuple } from '../../../../../../../shared/agent-session/background-tasks/agent-session-command-details'
import type { CommandDetailOpening } from '../../../../../../../shared/agent-session/view/live-read/command-detail-authority'
import { findStructuredAgentSessionReadOwner } from '../../../session/structured/read/structured-agent-session-read-owner-registry'
import { callRuntimeRpcResponse } from '@/runtime/rpc/calls/runtime-rpc-call'
import { observedRuntimeEnvironmentRuntimeId } from '@/runtime/rpc/compatibility/runtime-compatibility-cache'
import {
  readRuntimeStatuses,
  subscribeAppStoreWithStatuses
} from '@/store/slices/runtime-status/views/runtime-status-owner'
import { lastVerifiedRuntimeStatus } from '../../../../../../../shared/remote-runtime/host-status/runtime-host-status'
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

/** Every runtime this pairing has been seen to answer as: the accepted status the store keeps
 *  (durable across a compatibility cache clear) and the cached compatibility probe. */
function acceptedRuntimeIds(environmentId: string): (string | undefined)[] {
  return [
    lastVerifiedRuntimeStatus(readRuntimeStatuses().get(environmentId))?.runtimeId,
    observedRuntimeEnvironmentRuntimeId(environmentId)
  ]
}

/** Target, runtime incarnation and authenticated runtime the opening was made under: a re-pair,
 *  reconnect, or any accepted status or reply naming another runtime ends it, and the loss is
 *  sticky for this opening. */
function pinTarget(
  target: RuntimeClientTarget,
  runtimeId: () => string | undefined
): {
  current: () => boolean
  /** Latches a detected runtime mismatch; `current()` is false from then on. */
  mismatch: () => void
  pairingRevision: number | undefined
} {
  let mismatched = false
  const mismatch = (): void => {
    mismatched = true
  }
  if (target.kind !== 'environment') {
    return { current: () => !mismatched, mismatch, pairingRevision: undefined }
  }
  const { environmentId } = target
  const pairingRevision = getRuntimeEnvironmentRevision(environmentId)
  const connection = getRuntimeEnvironmentConnectionGeneration(environmentId)
  return {
    pairingRevision,
    mismatch,
    current: () => {
      const opened = runtimeId()
      if (acceptedRuntimeIds(environmentId).some((id) => id !== undefined && id !== opened)) {
        mismatched = true
      }
      return (
        !mismatched &&
        getRuntimeEnvironmentRevision(environmentId) === pairingRevision &&
        getRuntimeEnvironmentConnectionGeneration(environmentId) === connection
      )
    }
  }
}

/** Null when this reader holds no current credit for the tuple: the dialog shows the preview. */
export function openWorkerDockCommandDetail(input: {
  sessionId: string
  target: RuntimeClientTarget
  tuple: AgentSessionCommandDetailTuple
  call?: typeof callRuntimeRpcResponse
  timeoutMs?: number
  /** Monotonic clock for the read deadline; tests substitute one. */
  now?: () => number
}): WorkerDockCommandDetail | null {
  const { sessionId, target, tuple } = input
  const owner = findStructuredAgentSessionReadOwner(sessionId, target)
  if (!owner?.commandDetails) {
    return null
  }
  let openedRuntimeId: string | undefined
  const pinned = pinTarget(target, () => openedRuntimeId)
  const opening = owner.commandDetails.open(
    tuple,
    () => pinned.current() && findStructuredAgentSessionReadOwner(sessionId, target) === owner
  )
  if (!opening) {
    return null
  }
  openedRuntimeId = opening.runtimeId
  // A paired reader must know which runtime credited it; without that nothing can be pinned.
  if (target.kind === 'environment' && openedRuntimeId === undefined) {
    opening.close()
    return null
  }
  // A status naming another runtime ends the opening when it is accepted, not at the next click.
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  const stopStatusWatch = environmentId
    ? subscribeAppStoreWithStatuses((_state, _previous, statuses, previousStatuses) => {
        if (statuses.get(environmentId) !== previousStatuses.get(environmentId)) {
          opening.check()
        }
      })
    : () => {}
  opening.onLost(stopStatusWatch)
  const timeoutMs = input.timeoutMs ?? WORKER_DOCK_COMMAND_DETAIL_TIMEOUT_MS
  const now = input.now ?? (() => performance.now())
  /** The opening's one read gives up at this deadline; an unsent request may not leave after it. */
  let expired = false
  const call = input.call ?? callRuntimeRpcResponse
  let text: string | null = null
  let reading: Promise<string | null> | null = null
  const read = async (): Promise<string | null> => {
    // Dispatch check; a failed check latches the opening lost and notifies before refusing.
    if (!opening.check()) {
      return null
    }
    // One original cutoff, taken before any compatibility wait: checked at the final send and
    // again before a reply is admitted, whether or not the timer callback has run yet.
    const cutoff = now() + timeoutMs
    const elapsed = (): boolean => expired || now() >= cutoff
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => {
        expired = true
        resolve('timeout')
      }, timeoutMs)
    })
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
            timeoutMs,
            ...(pinned.pairingRevision !== undefined
              ? { expectedEnvironmentPairingRevision: pinned.pairingRevision }
              : {}),
            // Routed only to the runtime that credited this opening.
            ...(target.kind === 'environment'
              ? { expectedEnvironmentRuntimeId: openedRuntimeId }
              : {}),
            // After any compatibility await, before the request leaves: never past the deadline.
            beforeSend: () => {
              if (elapsed() || !opening.check()) {
                throw new CommandDetailRefused()
              }
            }
          }
        ),
        deadline
      ])
      // A reply from any other runtime is discarded, and this opening cannot recover.
      if (
        reply !== 'timeout' &&
        openedRuntimeId !== undefined &&
        reply._meta.runtimeId !== openedRuntimeId
      ) {
        pinned.mismatch()
      }
      // A late, refused or stale reply is discarded, never shown.
      if (reply === 'timeout' || elapsed() || !opening.check()) {
        return null
      }
      const command = reply.result.command
      if (typeof command !== 'string' || command.length === 0) {
        return null
      }
      text = command
      return command
    } catch {
      // Older hosts answer method-not-found; every failure is the approved fallback.
      return null
    } finally {
      clearTimeout(timer)
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
    close: () => {
      stopStatusWatch()
      opening.close()
    }
  }
}
