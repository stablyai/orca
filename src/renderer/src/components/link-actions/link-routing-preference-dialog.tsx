import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { lazyWithRetry } from '@/app-shell/startup/lazy-with-retry'
import { useLatchedOpen } from '@/app-shell/root-surfaces/use-latched-open'
import { useAppStore } from '@/store'
import {
  LinkRoutingPreferenceDialogContext,
  type LinkRoutingPreferenceDialogContextValue
} from './link-routing-preference-dialog-context'
import type { LinkRoutingPreferenceDialogRequest } from './LinkRoutingPreferenceDialogSurface'

const LazyLinkRoutingPreferenceDialogSurface = lazyWithRetry(
  () =>
    import('./LinkRoutingPreferenceDialogSurface').then((module) => ({
      default: module.LinkRoutingPreferenceDialogSurface
    })),
  { reloadKey: 'link-routing-preference-dialog-surface' }
)

const PREVIEW_STORAGE_KEY = 'orca.previewLinkRoutingPreferenceDialog'
const PREVIEW_DEFAULT_STORAGE_KEY = `${PREVIEW_STORAGE_KEY}.default`

export function LinkRoutingPreferenceDialogProvider({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  const nextIdRef = useRef(0)
  const [queue, setQueue] = useState<LinkRoutingPreferenceDialogRequest[]>([])
  const activeRequest = queue[0] ?? null
  const hasOpened = useLatchedOpen(activeRequest !== null)
  const setContextualToursBlockingSurfaceVisible = useAppStore(
    (s) => s.setContextualToursBlockingSurfaceVisible
  )

  useEffect(() => {
    setContextualToursBlockingSurfaceVisible(activeRequest !== null)
    return () => setContextualToursBlockingSurfaceVisible(false)
  }, [activeRequest, setContextualToursBlockingSurfaceVisible])

  const requestPreference = useCallback<LinkRoutingPreferenceDialogContextValue>((options = {}) => {
    return new Promise((resolve) => {
      const request: LinkRoutingPreferenceDialogRequest = {
        id: nextIdRef.current,
        options,
        resolve
      }
      nextIdRef.current += 1
      setQueue((currentQueue) => [...currentQueue, request])
    })
  }, [])

  useEffect(() => {
    if (!import.meta.env.DEV || typeof window === 'undefined') {
      return
    }
    if (window.sessionStorage.getItem(PREVIEW_STORAGE_KEY) !== '1') {
      return
    }
    const previewDefault = window.sessionStorage.getItem(PREVIEW_DEFAULT_STORAGE_KEY)
    window.sessionStorage.removeItem(PREVIEW_STORAGE_KEY)
    window.sessionStorage.removeItem(PREVIEW_DEFAULT_STORAGE_KEY)
    void requestPreference({
      openLinksInAppDefault: previewDefault === 'orca',
      preview: true,
      url: 'https://github.com/stablyai/orca/pull/1234'
    })
  }, [requestPreference])

  const settleRequest = useCallback(
    (request: LinkRoutingPreferenceDialogRequest, openInOrca: boolean) => {
      request.resolve(openInOrca)
      setQueue((currentQueue) => {
        if (currentQueue[0]?.id === request.id) {
          return currentQueue.slice(1)
        }
        return currentQueue.filter((queuedRequest) => queuedRequest.id !== request.id)
      })
    },
    []
  )

  return (
    <LinkRoutingPreferenceDialogContext.Provider value={requestPreference}>
      {children}
      {hasOpened ? (
        <Suspense fallback={null}>
          <LazyLinkRoutingPreferenceDialogSurface
            activeRequest={activeRequest}
            onSettle={settleRequest}
          />
        </Suspense>
      ) : null}
    </LinkRoutingPreferenceDialogContext.Provider>
  )
}
