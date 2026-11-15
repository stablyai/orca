import { useCallback, useLayoutEffect, type RefObject } from 'react'
import { isBlankBrowserUrl } from '@/lib/browser/palette/browser-palette-search'
import { useAppStore } from '@/store'
import type { BrowserPageInitializationAction } from '../../../../../shared/browser/client-hosting/browser-page-initialization-action'
import type { BrowserGuestMetadata } from '../../../../../shared/browser/guest-lifecycle/browser-guest-metadata'
import type { ClientHostedBrowserPagePaneProps } from '../describe-page/browser-page-types'
import { useRestoredClientHostedRecoveryWindow } from '../restored-client-hosted-recovery-window'
import { routeBrowserPageInitializationAction } from './browser-page-initialization-action'

export function useClientHostedPageInitialization(
  props: ClientHostedBrowserPagePaneProps,
  attachmentError: string | null,
  loadFailureRef: RefObject<BrowserGuestMetadata['loadError']>
) {
  const {
    browserTab,
    placement,
    runtimeEnvironmentId,
    workspaceId,
    worktreeId,
    onUpdatePageState
  } = props
  const presentation = useAppStore(
    (state) => state.remoteBrowserPageHandlesByPageId[browserTab.id]?.initializationPresentation
  )
  const ownedInitialization =
    presentation?.disposition === 'pending' || presentation?.disposition === 'stopped'
  const ownedPending = presentation?.disposition === 'pending'
  useLayoutEffect(() => {
    if (ownedInitialization) {
      loadFailureRef.current = null
    }
  }, [ownedInitialization, loadFailureRef])
  const restoredPageUnrecovered = useRestoredClientHostedRecoveryWindow({
    ownedInitialization,
    browserPageId: browserTab.id,
    environmentId: runtimeEnvironmentId,
    placementPending: placement === null
  })
  const actOnInitialization = useCallback(
    (action: BrowserPageInitializationAction) => {
      const handle = useAppStore.getState().remoteBrowserPageHandlesByPageId[browserTab.id]
      const expected = placement ?? handle?.placement
      if (expected?.kind !== 'client') {
        return
      }
      if (action.type === 'navigate') {
        loadFailureRef.current = null
        onUpdatePageState(browserTab.id, { loading: true, loadError: null })
      }
      void routeBrowserPageInitializationAction({
        pageId: browserTab.id,
        workspaceId,
        worktreeId,
        environmentId: runtimeEnvironmentId,
        placement: expected,
        action
      })
    },
    [
      loadFailureRef,
      browserTab.id,
      onUpdatePageState,
      placement,
      runtimeEnvironmentId,
      workspaceId,
      worktreeId
    ]
  )
  const initializationAction = ownedInitialization ? actOnInitialization : undefined
  const unavailable =
    presentation?.disposition === 'unavailable' ||
    (!ownedInitialization && (Boolean(attachmentError) || restoredPageUnrecovered))
  const showFailureOverlay = !presentation && !unavailable && Boolean(browserTab.loadError)

  // Unrecovered pages have no pending load that could ever clear a loading indicator.
  const loading = presentation
    ? ownedPending
    : !restoredPageUnrecovered && (placement === null || browserTab.loading)

  return {
    initializationAction,
    ownedInitialization,
    showNewTab: !presentation && isBlankBrowserUrl(browserTab.url),
    reloadPage: presentation ? { ...browserTab, loading, loadError: null } : browserTab,
    suppressAttachment: Boolean(presentation),
    unavailable,
    showFailureOverlay,
    loading
  }
}
