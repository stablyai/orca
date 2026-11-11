import { useCallback } from 'react'
import { useSessionRestoredBannerDismiss } from './useSessionRestoredBannerDismiss'
import {
  addSessionRestoredBannerPaneId,
  dismissSessionRestoredBannerPaneIds,
  removeSessionRestoredBannerPaneId,
  type SessionRestoredBannerDismissEvent,
  type SessionRestoredBannerReason
} from './session-restored-banner-pane-state'
import type { TerminalPaneStoreController } from '../controller/use-terminal-pane-store-bindings'

export function useRestoredSessionBannerActions({
  setSessionRestoredBannerPaneIds,
  managerRef,
  sessionRestoredBannerPaneIds,
  containerRef
}: Pick<
  TerminalPaneStoreController,
  'setSessionRestoredBannerPaneIds' | 'managerRef' | 'sessionRestoredBannerPaneIds' | 'containerRef'
>) {
  const clearSessionRestoredBannerForPane = useCallback(
    (paneId: number): void => {
      setSessionRestoredBannerPaneIds((previous) => {
        const next = removeSessionRestoredBannerPaneId(previous, paneId)
        return next === previous ? previous : next
      })
    },
    [setSessionRestoredBannerPaneIds]
  )
  const showRestoredSessionBanner = useCallback(
    (paneId: number, reason: SessionRestoredBannerReason = 'restored'): void => {
      setSessionRestoredBannerPaneIds((previous) => {
        const next = addSessionRestoredBannerPaneId(previous, paneId, reason)
        return next === previous ? previous : next
      })
    },
    [setSessionRestoredBannerPaneIds]
  )
  const dismissSessionRestoredBanner = useCallback(
    (event: SessionRestoredBannerDismissEvent): void => {
      setSessionRestoredBannerPaneIds((previous) =>
        dismissSessionRestoredBannerPaneIds(previous, event, managerRef.current?.getPanes() ?? [])
      )
    },
    [managerRef, setSessionRestoredBannerPaneIds]
  )
  useSessionRestoredBannerDismiss(
    sessionRestoredBannerPaneIds.size > 0,
    containerRef,
    dismissSessionRestoredBanner
  )
  return {
    clearSessionRestoredBannerForPane,
    showRestoredSessionBanner,
    dismissSessionRestoredBanner
  }
}
