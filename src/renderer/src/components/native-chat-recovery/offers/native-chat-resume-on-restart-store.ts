import type { NativeChatRestartStore } from './native-chat-restart-runtime-store'
import { RESTART_READ_RETRY_DELAYS_MS } from './native-chat-remote-restart-offer'
import { requestNativeChatResumeOnRestartDialog } from '../dialogs/native-chat-resume-on-restart-dialog'
import { useAppStore } from '../../../store/index'
import { markNativeChatLaunchResumeDecided } from './native-chat-launch-resume-decision'
import { launchResumeSessionIds } from '../tree/native-chat-resume-on-restart-grouping'
import { useEffect, useSyncExternalStore } from 'react'
import { createNativeChatRestartStore } from './native-chat-restart-runtime-store'
import { readRestartHostLaunchTaken } from './native-chat-restart-host-offer'

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
  // Launch reads the resume preference once, so it waits until settings have loaded.
  const settingsLoaded = useAppStore((state) => state.settings !== null)
  useEffect(() => {
    if (enabled && settingsLoaded && store.target.kind === 'local') {
      if (launch == null) {
        launch = loadNativeChatLaunchOffer(store).finally(markNativeChatLaunchResumeDecided)
      }
    }
  }, [enabled, settingsLoaded, store])
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

export async function loadNativeChatLaunchOffer(
  store: Pick<
    NativeChatRestartStore,
    'readNativeChatRestartOffer' | 'continueNativeChatRestartOffer' | 'target'
  >,
  readHostTaken = readRestartHostLaunchTaken
): Promise<void> {
  // The preference belongs to this launch's request; later saves cannot dispatch another.
  const autoResume = useAppStore.getState().settings?.nativeChatResumeWorkOnRestart === true
  // A host that continues on its own names what it took before any agent starts; show that as this
  // launch's run, then offer what it left to the person.
  const taken = await readHostTaken(store.target)
  const hostContinues = taken !== 'unsupported'
  if (hostContinues) {
    markNativeChatLaunchResumeDecided()
  }
  if (hostContinues && taken.length > 0) {
    await store.continueNativeChatRestartOffer(
      taken.map((row) => row.sessionId),
      'launch',
      taken
    )
  }
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
  // Failures left from an earlier launch are the status bar's to show; only a fresh offer or the
  // host's own run is reported.
  if (offered.length === 0 && !(hostContinues && taken.length > 0)) {
    return
  }
  // One toast reports the launch: a Resume button when the preference is off, the outcome when on.
  requestNativeChatResumeOnRestartDialog()
  if (autoResume && !hostContinues) {
    await store.continueNativeChatRestartOffer(launchResumeSessionIds(offered), 'launch')
  }
}

export function _resetNativeChatRestartOffer(): void {
  launch = undefined
  localNativeChatRestartStore._resetNativeChatRestartOffer()
}
