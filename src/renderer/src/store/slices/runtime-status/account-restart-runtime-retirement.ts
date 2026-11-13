import { lastVerifiedRuntimeStatus } from '../../../../../shared/remote-runtime/host-status/runtime-host-status'
import { isCodexAccountRestart } from '@/store/terminals/codex-account-restart-continuation'
import { releaseRetiredAccountRestartSlots } from '@/components/terminal-pane/account-restart/detached/detached-pane-restart-slots'
import type { RuntimeStatusStoreSetState, RuntimeStatusStoreState } from './runtime-status-types'

function retireChangedRuntimeRequests(
  state: RuntimeStatusStoreState,
  patch: Partial<RuntimeStatusStoreState>
): Partial<RuntimeStatusStoreState> {
  if (
    !state.paneAccountRestarts ||
    (!patch.runtimeEnvironments && !patch.runtimeStatusByEnvironmentId)
  ) {
    return patch
  }
  const catalog = patch.runtimeEnvironments
    ? new Map(patch.runtimeEnvironments.map((e) => [e.id, e]))
    : null
  let requests = state.paneAccountRestarts
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
    const revisionChanged =
      catalog &&
      (!environment || (environment.pairingRevision ?? environment.createdAt) !== expectedRevision)
    const runtimeId =
      patch.runtimeStatusByEnvironmentId &&
      lastVerifiedRuntimeStatus(patch.runtimeStatusByEnvironmentId.get(request.environmentId))
        ?.runtimeId
    if (!revisionChanged && !(request.runtimeId && runtimeId && runtimeId !== request.runtimeId)) {
      continue
    }
    if (requests === state.paneAccountRestarts) {
      requests = { ...requests }
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
  return requests === state.paneAccountRestarts
    ? patch
    : {
        ...patch,
        paneAccountRestarts: requests,
        ...(notices !== originalNotices ? { codexRestartNoticeByPtyId: notices } : {})
      }
}

export function withAccountRestartRuntimeRetirement(
  set: RuntimeStatusStoreSetState,
  get: () => RuntimeStatusStoreState
): RuntimeStatusStoreSetState {
  return (update) => {
    const before = get().paneAccountRestarts
    try {
      set((state) => {
        const patch = typeof update === 'function' ? update(state) : update
        return patch === state ? state : retireChangedRuntimeRequests(state, patch)
      })
    } finally {
      const after = get().paneAccountRestarts
      if (before && after) {
        releaseRetiredAccountRestartSlots(before, after)
      }
    }
  }
}
