import { Suspense, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { lazyWithRetry } from '@/app-shell/startup/lazy-with-retry'

const ORCA_REPO_URL = 'https://github.com/stablyai/orca'

const LazyStarNagToast = lazyWithRetry(
  () => import('./StarNagToast').then((module) => ({ default: module.StarNagToast })),
  { reloadKey: 'star-nag-toast' }
)

export function StarNagToastHost(): null {
  const activeToastIdRef = useRef<string | number | null>(null)
  const activeToastResolvedRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    const dismissActiveToast = (): void => {
      if (activeToastIdRef.current === null) {
        return
      }
      activeToastResolvedRef.current?.()
      toast.dismiss(activeToastIdRef.current)
    }
    const unsubscribeShow = window.api.starNag.onShow((payload) => {
      if (payload?.surface !== 'toast') {
        return
      }
      dismissActiveToast()
      let resolved = false
      let dismissSuppressed = false
      const markResolved = (): void => {
        resolved = true
      }
      const setDismissSuppressed = (suppressed: boolean): void => {
        dismissSuppressed = suppressed
      }
      activeToastResolvedRef.current = markResolved
      const id = toast.custom(
        (toastId) => (
          <Suspense fallback={null}>
            <LazyStarNagToast
              id={toastId}
              mode={payload.mode === 'web' ? 'web' : 'gh'}
              openRepoUrl={() => window.api.shell.openUrl(ORCA_REPO_URL)}
              markResolved={markResolved}
              setDismissSuppressed={setDismissSuppressed}
            />
          </Suspense>
        ),
        {
          duration: Infinity,
          closeButton: false,
          dismissible: false,
          unstyled: true,
          onDismiss: () => {
            if (activeToastIdRef.current === id) {
              activeToastIdRef.current = null
              activeToastResolvedRef.current = null
            }
            if (!resolved && !dismissSuppressed) {
              void window.api.starNag.dismiss()
            }
          },
          onAutoClose: () => {
            if (activeToastIdRef.current === id) {
              activeToastIdRef.current = null
              activeToastResolvedRef.current = null
            }
          }
        }
      )
      activeToastIdRef.current = id
    })
    const unsubscribeHide = window.api.starNag.onHide(dismissActiveToast)
    return () => {
      unsubscribeShow()
      unsubscribeHide()
      // Dismiss infinite-lived toasts on unmount so their React tree and callbacks cannot outlive this host.
      dismissActiveToast()
      activeToastIdRef.current = null
      activeToastResolvedRef.current = null
    }
  }, [])

  return null
}
