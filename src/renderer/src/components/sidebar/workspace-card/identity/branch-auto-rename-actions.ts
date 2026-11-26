import { useAppStore } from '@/store/index'
import { tryRuntimeTargetForWorktreeOwner } from '@/store/slices/worktrees/listing/worktree-owner-target'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/rpc/compatibility/runtime-capability-proof'
import { WORKTREE_AUTO_NAME_ACTIONS_RUNTIME_CAPABILITY } from '../../../../../../shared/remote-runtime/protocol/worktree-runtime-capabilities'
import {
  AUTO_NAME_RETRY_TIMEOUT_MS,
  AUTO_NAME_RPC_METHODS,
  type BranchAutoRenameDismissResult,
  type BranchAutoRenameRetryAvailability,
  type BranchAutoRenameRetryResult
} from '../../../../../../shared/worktree/branch-auto-rename-attempt'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { RuntimeClientTarget } from '../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'

type AutoNameTarget = { worktreeId: string; executionHostId: ExecutionHostId | undefined }

const UNAVAILABLE: BranchAutoRenameRetryAvailability = { available: false, runningAttemptId: null }

type AutoNameRoute =
  | { kind: 'local' }
  | { kind: 'environment'; target: RuntimeClientTarget }
  | { kind: 'unsupported' }

/** This app's own workspaces go to main; a paired server's go to it, when it serves the actions. */
async function resolveAutoNameRoute({
  worktreeId,
  executionHostId
}: AutoNameTarget): Promise<AutoNameRoute> {
  const target = tryRuntimeTargetForWorktreeOwner(
    useAppStore.getState(),
    worktreeId,
    executionHostId
  )
  if (!target) {
    return { kind: 'unsupported' }
  }
  if (target.kind === 'local') {
    return { kind: 'local' }
  }
  const supported = await runtimeEnvironmentSupportsCapability(
    target.environmentId,
    WORKTREE_AUTO_NAME_ACTIONS_RUNTIME_CAPABILITY
  )
  return supported ? { kind: 'environment', target } : { kind: 'unsupported' }
}

async function routeAutoName<T>(
  args: AutoNameTarget,
  local: () => Promise<T>,
  remote: { method: string; timeoutMs?: number; params?: Record<string, unknown> },
  unsupported: T
): Promise<T> {
  const route = await resolveAutoNameRoute(args)
  if (route.kind === 'local') {
    return local()
  }
  if (route.kind === 'unsupported') {
    return unsupported
  }
  return callRuntimeRpc<T>(
    route.target,
    remote.method,
    { worktreeId: args.worktreeId, ...remote.params },
    remote.timeoutMs ? { timeoutMs: remote.timeoutMs } : {}
  )
}

export function getAutoNameRetryAvailability(
  args: AutoNameTarget
): Promise<BranchAutoRenameRetryAvailability> {
  return routeAutoName(
    args,
    () => window.api.worktrees.getBranchAutoRenameRetryAvailability(args),
    { method: AUTO_NAME_RPC_METHODS.availability },
    UNAVAILABLE
  )
}

export function retryAutoName(args: AutoNameTarget): Promise<BranchAutoRenameRetryResult> {
  return routeAutoName(
    args,
    () => window.api.worktrees.retryBranchAutoRename(args),
    { method: AUTO_NAME_RPC_METHODS.retry, timeoutMs: AUTO_NAME_RETRY_TIMEOUT_MS },
    {
      attemptId: null,
      outcome: { kind: 'ineligible', reason: 'unavailable' },
      finishedAt: Date.now()
    }
  )
}

export function dismissAutoName(args: AutoNameTarget): Promise<BranchAutoRenameDismissResult> {
  return routeAutoName(
    args,
    () => window.api.worktrees.dismissBranchAutoRename(args),
    { method: AUTO_NAME_RPC_METHODS.dismiss },
    { dismissed: false }
  )
}

/** Attempt `attemptId`'s result once it finishes, from the host that runs it; null when it already had. */
export function waitForAutoNameAttempt(
  args: AutoNameTarget,
  attemptId: number
): Promise<BranchAutoRenameRetryResult | null> {
  return routeAutoName(
    args,
    () => window.api.worktrees.waitBranchAutoRenameAttempt({ ...args, attemptId }),
    {
      method: AUTO_NAME_RPC_METHODS.wait,
      timeoutMs: AUTO_NAME_RETRY_TIMEOUT_MS,
      params: { attemptId }
    },
    null
  )
}

/** Whether Dismiss can reach the workspace's host; an older paired server offers no actions. */
export function canDismissAutoName(args: AutoNameTarget): Promise<boolean> {
  return resolveAutoNameRoute(args).then(
    (route) => route.kind !== 'unsupported',
    () => false
  )
}
