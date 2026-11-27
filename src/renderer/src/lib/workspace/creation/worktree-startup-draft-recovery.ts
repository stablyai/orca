import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { runtimeRpcTargetForAuthorityKey } from '@/runtime/rpc/targets/runtime-client-target'
import { SETUP_WAIT_GATE_MAX_MS } from '../../../../../shared/agent-launch/startup/setup-wait-output-gate'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'
import { composeWorktreeHostIdentity } from '../../../../../shared/worktree/host-qualified-identity'
import type {
  AvailableStartupDraft,
  StartupDraftOutcome,
  StartupDraftReceipt
} from '../../../../../shared/worktree/creation/startup-draft-receipt'

const draftsByHost = new Map<ExecutionHostId, readonly AvailableStartupDraft[]>()
const listeners = new Set<() => void>()
let draftsByWorkspace = new Map<string, AvailableStartupDraft>()

export function applyStartupDraftSnapshot(
  hostId: ExecutionHostId,
  drafts: readonly AvailableStartupDraft[]
): void {
  if (drafts.length === 0 && !draftsByHost.has(hostId)) {
    return
  }
  if (drafts.length > 0) {
    draftsByHost.set(hostId, drafts)
  } else {
    draftsByHost.delete(hostId)
  }
  draftsByWorkspace = new Map(
    [...draftsByHost].flatMap(([host, records]) =>
      records.map(
        (record) => [composeWorktreeHostIdentity(host, record.worktreeId), record] as const
      )
    )
  )
  for (const listener of listeners) {
    listener()
  }
}

export function readStartupDraftSnapshot(): ReadonlyMap<string, AvailableStartupDraft> {
  return draftsByWorkspace
}

export function subscribeStartupDraftSnapshot(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function watchLocalStartupDrafts(): () => void {
  const subscribe = window.api?.worktrees?.onStartupDraftsChanged
  if (!subscribe) {
    return () => {}
  }
  let active = true
  let eventReceived = false
  const unsubscribe = subscribe((drafts) => {
    eventReceived = true
    applyStartupDraftSnapshot('local', drafts)
  })
  void callRuntimeRpc<AvailableStartupDraft[]>({ kind: 'local' }, 'worktree.startupDraft', {
    action: 'list'
  })
    .then((drafts) => {
      if (active && !eventReceived) {
        applyStartupDraftSnapshot('local', drafts)
      }
    })
    .catch(() => undefined)
  return () => {
    active = false
    unsubscribe()
  }
}

export function startupDraftRpc<TResult>(
  hostId: ExecutionHostId,
  receipt: StartupDraftReceipt,
  action: 'read' | 'wait' | 'dismiss' | 'release',
  signal?: AbortSignal
): Promise<TResult> {
  const target = runtimeRpcTargetForAuthorityKey(hostId)
  return target
    ? callRuntimeRpc<TResult>(
        target,
        'worktree.startupDraft',
        { action, id: receipt.id, worktreeId: receipt.worktreeId },
        action === 'wait'
          ? { timeoutMs: 2 * SETUP_WAIT_GATE_MAX_MS, background: true, signal }
          : { signal }
      )
    : Promise.reject(new Error('startup_draft_host_unavailable'))
}

export function waitForStartupDraftOutcome(
  hostId: ExecutionHostId,
  receipt: StartupDraftReceipt
): Promise<StartupDraftOutcome> {
  return startupDraftRpc<StartupDraftOutcome>(hostId, receipt, 'wait').catch(() => 'unknown')
}

export function releaseUnclaimedStartupDraft(
  hostId: ExecutionHostId,
  receipt: StartupDraftReceipt | undefined
): void {
  if (receipt) {
    void startupDraftRpc(hostId, receipt, 'release').catch(() => undefined)
  }
}
