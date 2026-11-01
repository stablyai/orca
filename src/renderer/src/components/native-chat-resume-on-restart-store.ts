import { RESTART_READ_RETRY_DELAYS_MS } from './native-chat-remote-restart-offer'
import { requestNativeChatResumeOnRestartDialog } from './native-chat-resume-on-restart-dialog'
import { useAppStore } from '../store'
import { markNativeChatLaunchResumeDecided } from './native-chat-launch-resume-decision'
import { allResumeSessionIds } from './native-chat-resume-on-restart-grouping'
import { useEffect, useSyncExternalStore } from 'react'
import { createNativeChatRestartStore } from './native-chat-restart-runtime-store'
export type { NativeChatRestartOffer } from './native-chat-restart-host-offer'
export { createNativeChatRestartStore } from './native-chat-restart-runtime-store'
export type NativeChatRestartStore = ReturnType<typeof createNativeChatRestartStore>
export const localNativeChatRestartStore = createNativeChatRestartStore({ kind: 'local' })
export const {
  getNativeChatRestartOffer,
  getNativeChatRestartResuming,
  getNativeChatRestartRun,
  markFinishedNativeChatRestartRunShown,
  releaseFinishedNativeChatRestartRun,
  refreshNativeChatRestartOffer,
  reopenNativeChatRestartOffer,
  continueNativeChatRestartOffer,
  dismissNativeChatRestartOffer
} = localNativeChatRestartStore

export function useNativeChatRestartOffer(enabled: boolean, store = localNativeChatRestartStore) {
  useEffect(() => {
    if (enabled && store.target.kind === 'local') {
      launch ??= loadLaunchOffer(store).finally(markNativeChatLaunchResumeDecided)
    }
  }, [enabled, store])
  return useSyncExternalStore(
    store.subscribe,
    store.getNativeChatRestartOffer,
    store.getNativeChatRestartOffer
  )
}
export function useNativeChatRestartResuming(store = localNativeChatRestartStore) {
  return useSyncExternalStore(
    store.subscribe,
    store.getNativeChatRestartResuming,
    store.getNativeChatRestartResuming
  )
}
export function useNativeChatRestartRun(store = localNativeChatRestartStore) {
  return useSyncExternalStore(
    store.subscribe,
    store.getNativeChatRestartRun,
    store.getNativeChatRestartRun
  )
}

let launch: Promise<void> | undefined

async function loadLaunchOffer(store: NativeChatRestartStore): Promise<void> {
  // The preference belongs to this launch's request; later saves cannot dispatch another.
  const autoResume = useAppStore.getState().settings?.nativeChatResumeWorkOnRestart === true
  let read = await store.readNativeChatRestartOffer()
  // Host startup can race the renderer. Retry only failed reads, never a confirmed empty result,
  // so a transient startup gap does not strand a durable offer or add steady-state polling.
  for (const delay of RESTART_READ_RETRY_DELAYS_MS) {
    if (read.available) {
      break
    }
    await new Promise<void>((resolve) => setTimeout(resolve, delay))
    read = await store.readNativeChatRestartOffer()
  }
  const offered = read.candidates
  // Failures left from an earlier launch are the status bar's to show; only a fresh offer asks.
  if (offered.length === 0) {
    return
  }
  if (!autoResume) {
    requestNativeChatResumeOnRestartDialog()
    return
  }
  await store.continueNativeChatRestartOffer(allResumeSessionIds(offered), 'launch')
}

export function _resetNativeChatRestartOffer(): void {
  launch = undefined
  localNativeChatRestartStore._resetNativeChatRestartOffer()
}
