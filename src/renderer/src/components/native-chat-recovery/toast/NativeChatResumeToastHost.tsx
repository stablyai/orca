import { useEffect, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import {
  localNativeChatRestartStore,
  useLocalRestartOffersEnabled,
  useNativeChatRestartOffer,
  useNativeChatRestartRun
} from '../offers/native-chat-resume-on-restart-store'
import type { NativeChatRestartStore } from '../offers/native-chat-restart-runtime-store'
import { useNativeChatRestartRuntimes } from '../offers/native-chat-restart-runtimes'
import { createSharedChunkLoad } from './shared-chunk-load'

// Why load before issuing: the toaster sizes a toast from its first render, and a Suspense fallback
// measures 0px, which drops the hovered card below its anchor and makes it jump.
const requestConnectedNativeChatResumeToast = createSharedChunkLoad(
  () =>
    import('./ConnectedNativeChatResumeToast').then((module) => ({
      default: module.ConnectedNativeChatResumeToast
    })),
  'connected-native-chat-resume-toast'
)

export function NativeChatResumeToasts(): React.JSX.Element {
  const enabled = useLocalRestartOffersEnabled()
  const runtimes = useNativeChatRestartRuntimes()
  return (
    <>
      <NativeChatResumeToastHost store={localNativeChatRestartStore} offerEnabled={enabled} />
      {runtimes.map(({ environment, store }) => (
        <NativeChatResumeToastHost key={environment.id} store={store} offerEnabled />
      ))}
    </>
  )
}

/** Shows the store's report while it has an open request and something to say. */
export function NativeChatResumeToastHost({
  store,
  offerEnabled
}: {
  store: NativeChatRestartStore
  offerEnabled: boolean
}): null {
  const { candidates, failed } = useNativeChatRestartOffer(offerEnabled, store)
  const run = useNativeChatRestartRun(store)
  // Read one-shot open requests directly; a local mirror could go stale between launch and status-bar requests.
  const open = useSyncExternalStore(
    store.subscribeNativeChatResumeOnRestartDialog,
    store.getNativeChatResumeOnRestartDialogRequest,
    store.getNativeChatResumeOnRestartDialogRequest
  )
  const visible =
    offerEnabled &&
    open &&
    ((run?.entries.length ?? 0) > 0 || candidates.length + failed.length > 0)
  const id = `native-chat-resume:${store.target.kind === 'local' ? 'local' : store.target.environmentId}`
  useEffect(() => {
    if (!visible) {
      return
    }
    // Only the person's own dismissal or the report's own timeout snoozes; this effect's cleanup must not consume a later request.
    let owned = true
    const snooze = (): void => {
      if (owned) {
        store.consumeNativeChatResumeOnRestartDialogRequest()
        store.releaseFinishedNativeChatRestartRun()
      }
    }
    const request = requestConnectedNativeChatResumeToast()
    void request.loaded
      .then(({ default: ConnectedNativeChatResumeToast }) => {
        if (!owned) {
          return
        }
        // The report owns its timer so window visibility recovery can resume it. Re-issues render the
        // same component, so they update this toast in place instead of remounting it.
        toast.custom(() => <ConnectedNativeChatResumeToast store={store} toastId={id} />, {
          id,
          duration: Infinity,
          closeButton: false,
          unstyled: true,
          onDismiss: snooze
        })
      })
      .catch((error: unknown) => {
        console.warn('[native-chat-recovery] resume report failed to load:', error)
        // Release only the open request, so the status bar can ask again; an unseen run stays for it.
        if (owned) {
          store.consumeNativeChatResumeOnRestartDialogRequest()
        }
      })
    return () => {
      owned = false
      request.release()
      toast.dismiss(id)
    }
  }, [visible, id, store])
  return null
}
