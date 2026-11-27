import { Suspense, useEffect, useState } from 'react'
import { lazyWithRetry } from '@/app-shell/startup/lazy-with-retry'
import { useAppStore } from '../../store/index'
import { shouldShowUnexpectedSignoutCard } from './unexpected-signout-visibility'

const LazyUnexpectedSignoutCardBody = lazyWithRetry(
  () =>
    import('./UnexpectedSignoutCardBody').then((module) => ({
      default: module.UnexpectedSignoutCardBody
    })),
  { reloadKey: 'unexpected-signout-card-body' }
)

function readPreviewFlag(): boolean {
  if (!import.meta.env.DEV) {
    return false
  }
  try {
    if (new URLSearchParams(window.location.search).get('showSignoutCard') === '1') {
      return true
    }
    return window.localStorage.getItem('orca-debug-show-signout-card') === '1'
  } catch {
    return false
  }
}

export function UnexpectedSignoutCard(): React.JSX.Element | null {
  const authStatus = useAppStore((s) => s.orcaProfileAuthStatus)
  const persistedUIReady = useAppStore((s) => s.persistedUIReady)
  const persistedDismissedVersion = useAppStore((s) => s.dismissedUnexpectedSignoutVersion)
  const dismissedVersions = useAppStore((s) => s.unexpectedSignoutDismissedVersions)
  const dismissForVersion = useAppStore((s) => s.dismissUnexpectedSignoutCard)
  const [appVersion, setAppVersion] = useState<string | null>(null)
  const [authRefreshReady, setAuthRefreshReady] = useState(false)
  const [preview] = useState(readPreviewFlag)
  const [previewDismissed, setPreviewDismissed] = useState(false)
  const [appearance, setAppearance] = useState<'unseen' | 'visible' | 'closed'>('unseen')

  useEffect(() => {
    let cancelled = false
    let attempts = 0
    let retryTimer: number | null = null
    const refresh = (): void => {
      attempts += 1
      void useAppStore
        .getState()
        .fetchOrcaProfileAuthStatus()
        .then((status) => {
          if (cancelled) {
            return
          }
          if (status != null) {
            setAuthRefreshReady(true)
          } else if (attempts < 3) {
            retryTimer = window.setTimeout(() => {
              retryTimer = null
              refresh()
            }, 500)
          }
        })
    }
    refresh()
    return () => {
      cancelled = true
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer)
      }
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void window.api.updater
      .getVersion()
      .then((version) => {
        if (!cancelled) {
          setAppVersion(version)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAppVersion(null)
        }
      })
    return () => {
      cancelled = true
    }
  }, [])

  const dismissedVersion = dismissedVersions[0] ?? persistedDismissedVersion
  const eligible = shouldShowUnexpectedSignoutCard({
    authStatus,
    persistedUIReady,
    appVersion,
    dismissedVersion: appearance === 'visible' ? null : dismissedVersion
  })
  const visible = preview
    ? persistedUIReady && !previewDismissed
    : authRefreshReady && appearance !== 'closed' && eligible

  // Record the first appearance without closing the card currently being read.
  useEffect(() => {
    if (preview) {
      return
    }
    if (visible && appearance === 'unseen' && appVersion) {
      setAppearance('visible')
      dismissForVersion(appVersion)
    } else if (!visible && appearance === 'visible') {
      setAppearance('closed')
    }
  }, [preview, visible, appearance, appVersion, dismissForVersion])

  if (!visible) {
    return null
  }

  const email = authStatus?.cloud?.email?.trim() || null
  const canConnect = authStatus?.configured === true

  const handleDismiss = (): void => {
    if (preview) {
      setPreviewDismissed(true)
    } else {
      setAppearance('closed')
    }
  }

  return (
    <Suspense fallback={null}>
      <LazyUnexpectedSignoutCardBody
        email={email}
        canConnect={canConnect}
        onDismiss={handleDismiss}
      />
    </Suspense>
  )
}
