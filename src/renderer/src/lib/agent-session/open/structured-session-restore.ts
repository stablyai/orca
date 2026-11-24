import {
  structuredSessionOpenFailure,
  type StructuredSessionOpenFailure,
  type StructuredSessionOpenTarget
} from '../../../../../shared/agent-session/view/open-structured-agent-session'
import { unreachableOpenFailure } from '../../../../../shared/agent-session/view/structured-session-open-failure-detail'
import { STRUCTURED_AGENT_SESSION_REVEAL_RUNTIME_CAPABILITY } from '../../../../../shared/agent-session/capabilities/structured-agent-session-surface-capabilities'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { OrchestrationPartyLocationResult } from '../../../../../shared/orchestration/orchestration-caller-status'
import {
  throwIfSignalAborted,
  waitForPromiseWithSignal
} from '../../../../../shared/concurrency/abort-signal-reason'
import { useAppStore } from '@/store/index'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '../../workspace/ownership/worktree-runtime-owner'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/rpc/compatibility/runtime-capability-proof'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/rpc/targets/runtime-client-target'
import { toRuntimeWorktreeSelector } from '@/runtime/rpc/targets/runtime-worktree-selector'
import { refreshLocalStructuredSessionWorktreeTabs } from '@/runtime/local-structured-session-tabs-sync/inventory-refresh'
import { isRuntimeCompatBlockError } from '@/runtime/rpc/compatibility/runtime-protocol-compat'

export const STRUCTURED_SESSION_RESTORE_TIMEOUT_MS = 5_000

/** Keep distinct remedies: retry unreachable hosts, stop on a confirmed missing record, or update incompatible hosts/adapters. Failure to answer never proves a chat is gone. */
export type StructuredSessionRevealOutcome =
  | StructuredSessionOpenTarget
  | StructuredSessionOpenFailure
  | 'gone'
  | 'host-cannot-open'
  | 'unreachable'

export function callStructuredSessionParty(
  owner: RuntimeClientTarget,
  method: 'orchestration.partyLocation' | 'orchestration.partyOpen',
  address: string,
  messageIds: readonly string[],
  options?: { beforeSend?: () => void }
): Promise<OrchestrationPartyLocationResult> {
  return callRuntimeRpc<OrchestrationPartyLocationResult>(
    owner,
    method,
    { address, ...(messageIds.length ? { messageIds } : {}) },
    { timeoutMs: STRUCTURED_SESSION_RESTORE_TIMEOUT_MS, ...options }
  )
}

/** Only revealed promises a tab; preserve distinct retry/missing/update outcomes for the other replies. */
export async function revealStructuredSession(target: {
  worktreeId: string
  sessionId: string
  target?: RuntimeClientTarget
  signal?: AbortSignal
  beforeSend?: () => void
}): Promise<StructuredSessionRevealOutcome> {
  const host =
    target.target ??
    runtimeTargetForOwnerEnvironment(
      runtimeEnvironmentIdOrLocalUnlessTwin(useAppStore.getState(), target.worktreeId)
    )
  // Probe the answering paired host’s build; the local host shares this build and needs no probe.
  if (host.kind === 'environment') {
    let supported: boolean
    try {
      target.beforeSend?.()
      // Race even cached probe promises: an older unbounded probe must not hold the session’s in-flight guard forever.
      supported = await withStructuredSessionRestoreTimeout(
        runtimeEnvironmentSupportsCapability(
          host.environmentId,
          STRUCTURED_AGENT_SESSION_REVEAL_RUNTIME_CAPABILITY,
          STRUCTURED_SESSION_RESTORE_TIMEOUT_MS
        ),
        { signal: target.signal }
      )
    } catch (error) {
      // Only a version block proves age; other probe failures say nothing about the chat (as in remote-agent-session-launch).
      return isRuntimeCompatBlockError(error) ? 'host-cannot-open' : unreachableOpenFailure(error)
    }
    if (!supported) {
      return 'host-cannot-open'
    }
  }
  let result: AgentSessionRevealReply | undefined
  try {
    const request = callRuntimeRpc<AgentSessionRevealReply>(
      host,
      'agentSession.reveal',
      { sessionId: target.sessionId },
      {
        timeoutMs: STRUCTURED_SESSION_RESTORE_TIMEOUT_MS,
        beforeSend:
          target.beforeSend ??
          (target.signal ? () => throwIfSignalAborted(target.signal) : undefined)
      }
    )
    result = await (target.beforeSend
      ? request
      : withStructuredSessionRestoreTimeout(request, { signal: target.signal }))
  } catch (error) {
    return unreachableOpenFailure(error)
  }
  if (result?.ok === true) {
    return { sessionId: result.sessionId, worktreeId: result.workspaceId, agent: result.agent }
  }
  // Distinguish a missing record from an existing record the host cannot open; only the first means gone.
  if (result?.refusal?.code === 'agent_session_workspace_removed') {
    return structuredSessionOpenFailure(result.refusal)
  }
  return result?.refusal?.code === 'agent_session_identity_required'
    ? 'gone'
    : result?.refusal?.code === 'agent_session_operation_unknown'
      ? unreachableOpenFailure(result.refusal)
      : 'host-cannot-open'
}

type AgentSessionRevealReply =
  | { ok: true; sessionId: string; workspaceId: string; agent: string }
  | { ok: false; refusal: { code?: string; message?: string; details?: unknown } }

export async function refreshStructuredSessionTabs(
  worktreeId: string,
  host: RuntimeClientTarget
): Promise<void> {
  if (host.kind === 'local') {
    await withStructuredSessionRestoreTimeout(refreshLocalStructuredSessionWorktreeTabs(worktreeId))
    return
  }
  // Paired inventories arrive through their existing host-scoped subscription.
  await withStructuredSessionRestoreTimeout(
    callRuntimeRpc(
      host,
      'session.tabs.list',
      { worktree: toRuntimeWorktreeSelector(worktreeId) },
      { timeoutMs: STRUCTURED_SESSION_RESTORE_TIMEOUT_MS }
    )
  )
}

export async function withStructuredSessionRestoreTimeout<T>(
  promise: Promise<T>,
  options?: { signal?: AbortSignal; onTimeout?: () => void }
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      waitForPromiseWithSignal(promise, options?.signal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          options?.onTimeout?.()
          reject(new Error('structured_session_restore_timeout'))
        }, STRUCTURED_SESSION_RESTORE_TIMEOUT_MS)
      })
    ])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}
