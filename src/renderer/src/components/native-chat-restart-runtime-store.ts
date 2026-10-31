import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { RuntimeEnvironmentStatus } from '../../../shared/runtime-host-status'
import { remoteRestartRuntimeId } from './native-chat-remote-restart-offer'
import { createNativeChatRestartOccurrence } from './native-chat-restart-occurrence'
import { EMPTY } from './native-chat-restart-host-offer'
import {
  resumeRunPendingIds,
  type ResumeRun,
  type ResumeRunStarter
} from './native-chat-resume-run'
import * as dialog from './native-chat-resume-on-restart-dialog'

const NO_RESUMING = resumeRunPendingIds(null)

/** Subscriptions survive server replacement; all recovery state and work belongs to its occurrence. */
export function createNativeChatRestartStore(target: RuntimeClientTarget) {
  const key = target.kind === 'local' ? 'local' : target.environmentId
  const consumeNativeChatResumeOnRestartDialogRequest = () =>
    dialog.consumeNativeChatResumeOnRestartDialogRequest(key)
  const getNativeChatResumeOnRestartDialogRequest = () =>
    dialog.getNativeChatResumeOnRestartDialogRequest(key)
  const subscribeNativeChatResumeOnRestartDialog = dialog.subscribeNativeChatResumeOnRestartDialog
  const listeners = new Set<() => void>()
  let disposed = false
  let runtimeId: string | undefined
  let occurrence = createNativeChatRestartOccurrence(target, key, listeners)
  function subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  function dispose(): void {
    disposed = true
    occurrence.dispose()
    listeners.forEach((listener) => listener())
  }
  return {
    target,
    subscribe,
    dispose,
    getNativeChatRestartOccurrence: () => occurrence,
    getNativeChatRestartOffer: () => (disposed ? EMPTY : occurrence.getNativeChatRestartOffer()),
    getNativeChatRestartResuming: () =>
      disposed ? NO_RESUMING : occurrence.getNativeChatRestartResuming(),
    getNativeChatRestartRun: () => (disposed ? null : occurrence.getNativeChatRestartRun()),
    markFinishedNativeChatRestartRunShown: (run: ResumeRun) =>
      occurrence.markFinishedNativeChatRestartRunShown(run),
    releaseFinishedNativeChatRestartRun: () => occurrence.releaseFinishedNativeChatRestartRun(),
    refreshNativeChatRestartOffer: () => occurrence.refreshNativeChatRestartOffer(),
    reopenNativeChatRestartOffer: () => occurrence.reopenNativeChatRestartOffer(),
    continueNativeChatRestartOffer: (ids: readonly string[], starter?: ResumeRunStarter) =>
      occurrence.continueNativeChatRestartOffer(ids, starter),
    dismissNativeChatRestartOffer: (ids?: readonly string[]) =>
      occurrence.dismissNativeChatRestartOffer(ids),
    readNativeChatRestartOffer: () => occurrence.readNativeChatRestartOffer(),
    startedHere: (id: string) => !disposed && occurrence.startedHere(id),
    consumeNativeChatResumeOnRestartDialogRequest: () => {
      if (!disposed) {
        consumeNativeChatResumeOnRestartDialogRequest()
      }
    },
    getNativeChatResumeOnRestartDialogRequest,
    subscribeNativeChatResumeOnRestartDialog,
    observeRuntimeStatus: (status: RuntimeEnvironmentStatus | undefined) => {
      if (disposed) {
        return
      }
      const id = remoteRestartRuntimeId(status)
      if (id && runtimeId !== id) {
        occurrence.dispose()
        runtimeId = id
        occurrence = createNativeChatRestartOccurrence(target, key, listeners)
        listeners.forEach((listener) => listener())
      }
      occurrence.observeRuntimeStatus(status)
    },
    _resetNativeChatRestartOffer: () => {
      occurrence.dispose()
      disposed = false
      runtimeId = undefined
      occurrence = createNativeChatRestartOccurrence(target, key, listeners)
      listeners.clear()
    }
  }
}
