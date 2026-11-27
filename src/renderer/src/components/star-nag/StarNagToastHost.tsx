import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { loadLazyWithRetry } from '@/app-shell/startup/lazy-with-retry'
import type { StarNagToast as StarNagToastComponent } from './StarNagToast'

const ORCA_REPO_URL = 'https://github.com/stablyai/orca'

// Why load before issuing: the toaster sizes a toast from its first render, and a Suspense fallback
// measures 0px, which drops the hovered card below its anchor and makes it jump.
const loadStarNagToast = () =>
  loadLazyWithRetry(
    () => import('./StarNagToast').then((module) => ({ default: module.StarNagToast })),
    { reloadKey: 'star-nag-toast' }
  )

export function StarNagToastHost(): null {
  const activeToastIdRef = useRef<string | number | null>(null)
  const activeToastResolvedRef = useRef<(() => void) | null>(null)

  useEffect(() => {
    // Bumped by every show, hide and unmount, so a show still loading its toast can tell it was overtaken.
    let generation = 0
    const dismissActiveToast = (): void => {
      generation += 1
      if (activeToastIdRef.current === null) {
        return
      }
      activeToastResolvedRef.current?.()
      toast.dismiss(activeToastIdRef.current)
    }
    const showToast = (StarNagToast: typeof StarNagToastComponent, web: boolean): void => {
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
          <StarNagToast
            id={toastId}
            mode={web ? 'web' : 'gh'}
            openRepoUrl={() => window.api.shell.openUrl(ORCA_REPO_URL)}
            markResolved={markResolved}
            setDismissSuppressed={setDismissSuppressed}
          />
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
    }
    const unsubscribeShow = window.api.starNag.onShow((payload) => {
      if (payload?.surface !== 'toast') {
        return
      }
      dismissActiveToast()
      const shown = generation
      void loadStarNagToast()
        .then(({ default: StarNagToast }) => {
          if (shown === generation) {
            showToast(StarNagToast, payload.mode === 'web')
          }
        })
        .catch((error: unknown) => {
          console.warn('[star-nag] toast failed to load:', error)
        })
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
