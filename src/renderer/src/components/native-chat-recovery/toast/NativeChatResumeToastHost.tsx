import { Suspense, useEffect, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { lazyWithRetry } from '@/app-shell/startup/lazy-with-retry'
import {
  localNativeChatRestartStore,
  useLocalRestartOffersEnabled,
  useNativeChatRestartOffer,
  useNativeChatRestartRun
} from '../offers/native-chat-resume-on-restart-store'
import type { NativeChatRestartStore } from '../offers/native-chat-restart-runtime-store'
import { useNativeChatRestartRuntimes } from '../offers/native-chat-restart-runtimes'

const LazyConnectedNativeChatResumeToast = lazyWithRetry(
  () =>
    import('./ConnectedNativeChatResumeToast').then((module) => ({
      default: module.ConnectedNativeChatResumeToast
    })),
  { reloadKey: 'connected-native-chat-resume-toast' }
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
function NativeChatResumeToastHost({
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
    // The report owns its timer so window visibility recovery can resume it.
    toast.custom(
      () => (
        <Suspense fallback={null}>
          <LazyConnectedNativeChatResumeToast store={store} toastId={id} />
        </Suspense>
      ),
      {
        id,
        duration: Infinity,
        closeButton: false,
        unstyled: true,
        onDismiss: snooze
      }
    )
    return () => {
      owned = false
      toast.dismiss(id)
    }
  }, [visible, id, store])
  return null
}
