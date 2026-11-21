import { lastVerifiedRuntimeStatus } from '../../../../../shared/remote-runtime/host-status/runtime-host-status'
import {
  isCodexAccountRestart,
  reconcileRetiredCodexNotices
} from '@/store/terminals/codex-account-restart-continuation'
import { releaseRetiredAccountRestartSlots } from '@/components/terminal-pane/account-restart/detached/detached-pane-restart-slots'
import {
  isRuntimeEnvironmentContinuationPending,
  resolveContinuedRuntimeEnvironmentRevision
} from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import type { CodexAccountRestart } from '../../terminals/terminal-contracts'
import type { RuntimeStatusStoreSetState, RuntimeStatusStoreState } from './runtime-status-types'
import { openStatusTransactionFor } from '../../status-transaction/status-transaction'
import type { HostStatusReplacement } from './host-status-transaction-draft'

/** The status this write gives `environmentId`, whether patched directly or staged in its status transaction. */
function writtenRuntimeStatus(
  patch: Partial<RuntimeStatusStoreState>,
  staged: readonly HostStatusReplacement[] | undefined,
  environmentId: string
): HostStatusReplacement[1] | undefined {
  if (patch.runtimeStatusByEnvironmentId) {
    return patch.runtimeStatusByEnvironmentId.get(environmentId)
  }
  return staged?.findLast(([id]) => id === environmentId)?.[1]
}

function retainedPairingRevision(
  environmentId: string,
  request: CodexAccountRestart,
  previousRevision: number,
  nextRevision: number
): number | undefined {
  if (
    resolveContinuedRuntimeEnvironmentRevision(environmentId, previousRevision) === nextRevision
  ) {
    return nextRevision
  }
  // Keep Retry fenced to the old pairing while a managed re-pair is verifying its host key.
  if (
    (request.phase === 'failed' || request.phase === 'unresolved') &&
    isRuntimeEnvironmentContinuationPending(environmentId, previousRevision)
  ) {
    return previousRevision
  }
  return undefined
}

function retireChangedRuntimeRequests(
  state: RuntimeStatusStoreState,
  patch: Partial<RuntimeStatusStoreState>
): Partial<RuntimeStatusStoreState> {
  // Why: the app store stages host statuses in a status transaction rather than in this patch.
  const staged = openStatusTransactionFor(state)?.hostStatuses
  if (
    !state.pendingPaneAccountRestarts ||
    (!patch.runtimeEnvironments && !patch.runtimeStatusByEnvironmentId && !staged)
  ) {
    return patch
  }
  const catalog = patch.runtimeEnvironments
    ? new Map(patch.runtimeEnvironments.map((e) => [e.id, e]))
    : null
  let requests = state.pendingPaneAccountRestarts
  const originalNotices = patch.codexRestartNoticeByPtyId ?? state.codexRestartNoticeByPtyId
  let notices = originalNotices
  for (const [key, request] of Object.entries(requests)) {
    if (!isCodexAccountRestart(request) || !request.environmentId) {
      continue
    }
    const environment = catalog?.get(request.environmentId)
    const previous = state.runtimeEnvironments.find((e) => e.id === request.environmentId)
    const expectedRevision =
      request.pairingRevision ?? previous?.pairingRevision ?? previous?.createdAt
    const nextRevision = environment && (environment.pairingRevision ?? environment.createdAt)
    const revisionChanged = catalog && (!environment || nextRevision !== expectedRevision)
    const runtimeId = lastVerifiedRuntimeStatus(
      writtenRuntimeStatus(patch, staged, request.environmentId)
    )?.runtimeId
    const runtimeChanged = Boolean(
      request.runtimeId && runtimeId && runtimeId !== request.runtimeId
    )
    if (!revisionChanged && !runtimeChanged) {
      continue
    }
    const keptRevision =
      !runtimeChanged && nextRevision !== undefined && expectedRevision !== undefined
        ? retainedPairingRevision(request.environmentId, request, expectedRevision, nextRevision)
        : undefined
    if (keptRevision !== undefined && request.pairingRevision === keptRevision) {
      continue
    }
    if (requests === state.pendingPaneAccountRestarts) {
      requests = { ...requests }
    }
    if (keptRevision !== undefined) {
      requests[key] = { ...request, pairingRevision: keptRevision }
      continue
    }
    delete requests[key]
    const notice = notices?.[request.oldPtyId]
    if (
      notices &&
      notice?.restartRequested &&
      (!notice.incarnationId || notice.incarnationId === request.oldIncarnationId)
    ) {
      if (notices === originalNotices) {
        notices = { ...notices }
      }
      delete notices[request.oldPtyId]
    }
  }
  const next = { ...state, ...patch }
  if (next.tabsByWorktree && next.terminalLayoutsByTabId && next.ptyIdsByTabId && originalNotices) {
    notices = reconcileRetiredCodexNotices(
      { pendingPaneAccountRestarts: state.pendingPaneAccountRestarts },
      {
        ...next,
        tabsByWorktree: next.tabsByWorktree,
        terminalLayoutsByTabId: next.terminalLayoutsByTabId,
        ptyIdsByTabId: next.ptyIdsByTabId,
        pendingPaneAccountRestarts: requests,
        codexRestartNoticeByPtyId: originalNotices
      }
    )
  }
  return requests === state.pendingPaneAccountRestarts
    ? patch
    : {
        ...patch,
        pendingPaneAccountRestarts: requests,
        ...(notices !== originalNotices ? { codexRestartNoticeByPtyId: notices } : {})
      }
}

export function withAccountRestartRuntimeRetirement(
  set: RuntimeStatusStoreSetState,
  get: () => RuntimeStatusStoreState
): RuntimeStatusStoreSetState {
  return (update) => {
    const before = get().pendingPaneAccountRestarts
    try {
      set((state) => {
        const patch = typeof update === 'function' ? update(state) : update
        return patch === state ? state : retireChangedRuntimeRequests(state, patch)
      })
    } finally {
      const after = get().pendingPaneAccountRestarts
      if (before && after) {
        releaseRetiredAccountRestartSlots(before, after)
      }
    }
  }
}
