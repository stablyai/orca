import {
  captureBrowserInitializationDelivery,
  isBrowserInitializationDeliveryCurrent,
  recordBrowserInitializationReceipt
} from '@/runtime/web-session-tabs-sync/browser-initialization-presentation'
import { sameRuntimeBrowserPlacement } from '../../../../../shared/runtime-browser-placement'
import { useAppStore } from '@/store'
import type { BrowserPageInitializationAction } from '../../../../../shared/browser/client-hosting/browser-page-initialization-action'
import type { RuntimeBrowserClientPlacement } from '../../../../../shared/runtime-browser-placement'
import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/runtime-session-contracts'
import type { RuntimeRpcResponse } from '../../../../../shared/runtime-rpc-envelope'
import { captureRuntimeEnvironmentCall } from '@/runtime/web-session-tabs-sync/identity/web-runtime-session-environment'
import { getRuntimeEnvironmentRevision } from '@/runtime/rpc/environment-revisions/runtime-environment-revision'
import { getRuntimeEnvironmentConnectionGeneration } from '@/store/slices/runtime-status/runtime-status-connection-generation'
import { unwrapRuntimeRpcResult } from '@/runtime/rpc/calls/runtime-rpc-result'
import { toRuntimeWorktreeSelector } from '@/runtime/rpc/targets/runtime-worktree-selector'
import { nextReceivedSessionTabsFrame } from '@/runtime/web-session-tabs-sync/state'
import { getSessionTabsRuntimeIdFromResponse } from '@/runtime/web-session-tabs-sync/publisher-identity-fences'
import {
  applyWebRuntimeSessionTabsAnswer,
  refreshWebRuntimeSessionTabsSnapshot
} from '@/runtime/web-session-tabs-sync/inventory/web-runtime-session-snapshot'
import {
  beginBrowserPageInitializationAction,
  endBrowserPageInitializationAction,
  hasBrowserPageInitializationAction
} from './browser-page-deferred-navigation'

export async function routeBrowserPageInitializationAction(input: {
  pageId: string
  workspaceId: string
  worktreeId: string
  environmentId: string
  placement: RuntimeBrowserClientPlacement
  action: BrowserPageInitializationAction
}): Promise<void> {
  const { pageId, environmentId } = input
  const delivery = captureBrowserInitializationDelivery(environmentId)
  const presentation =
    useAppStore.getState().remoteBrowserPageHandlesByPageId[pageId]?.initializationPresentation
  const token = beginBrowserPageInitializationAction(pageId)
  const revision = getRuntimeEnvironmentRevision(environmentId)
  const connection = getRuntimeEnvironmentConnectionGeneration(environmentId)
  const remotePageId = useAppStore.getState().remoteBrowserPageHandlesByPageId[pageId]?.remotePageId
  const receivedFrame = nextReceivedSessionTabsFrame()
  const alive = (): boolean => {
    const state = useAppStore.getState()
    const handle = state.remoteBrowserPageHandlesByPageId[pageId]
    return (
      isBrowserInitializationDeliveryCurrent(delivery) &&
      getRuntimeEnvironmentRevision(environmentId) === revision &&
      getRuntimeEnvironmentConnectionGeneration(environmentId) === connection &&
      handle?.environmentId === environmentId &&
      handle.remotePageId === remotePageId &&
      Boolean(state.browserPagesByWorkspace[input.workspaceId]?.some((page) => page.id === pageId))
    )
  }
  const live = (): boolean => {
    const handle = useAppStore.getState().remoteBrowserPageHandlesByPageId[pageId]
    return (
      alive() &&
      handle?.initializationPresentation?.delivery === presentation?.delivery &&
      Boolean(handle?.placement && sameRuntimeBrowserPlacement(handle.placement, input.placement))
    )
  }
  const current = (): boolean => live() && hasBrowserPageInitializationAction(pageId, token)
  let applied = false
  let released = false
  try {
    const response = await captureRuntimeEnvironmentCall(
      environmentId,
      revision
    )({
      method: 'browser.clientPage.initializationAction',
      params: {
        worktree: toRuntimeWorktreeSelector(input.worktreeId),
        page: remotePageId ?? pageId,
        expectedPlacement: input.placement,
        action: input.action
      },
      timeoutMs: 15_000
    })
    if (!current()) {
      return
    }
    // SAFETY: this method returns the same caller-projected session snapshot as session.tabs.list.
    const snapshot = unwrapRuntimeRpcResult(
      response as RuntimeRpcResponse<RuntimeMobileSessionTabsResult>
    )
    recordBrowserInitializationReceipt(environmentId, snapshot, receivedFrame, delivery)
    applied = await applyWebRuntimeSessionTabsAnswer(
      environmentId,
      input.worktreeId,
      {
        snapshot,
        receivedFrame,
        runtimeId: getSessionTabsRuntimeIdFromResponse(response)
      },
      {
        expectedEnvironmentPairingRevision: revision,
        errorMode: 'throw',
        isCurrent: current,
        beforeApply: () => {
          released = endBrowserPageInitializationAction(pageId, token)
        }
      }
    )
  } catch {
    // A control rejection is not a guest document error; the current snapshot owns its outcome.
  } finally {
    released = endBrowserPageInitializationAction(pageId, token) || released
    if (!applied && released && alive() && !hasBrowserPageInitializationAction(pageId)) {
      const state = useAppStore.getState()
      const page = state.browserPagesByWorkspace[input.workspaceId]?.find(
        (page) => page.id === pageId
      )
      const handle = state.remoteBrowserPageHandlesByPageId[pageId]
      await refreshWebRuntimeSessionTabsSnapshot(environmentId, input.worktreeId, {
        expectedEnvironmentPairingRevision: revision,
        acceptCurrentSnapshot: true,
        afterCurrentInFlight: true,
        isCurrent: () => alive() && !hasBrowserPageInitializationAction(pageId),
        ...(page && handle ? { reconcileBrowserPage: { page, handle } } : {})
      })
    }
  }
}
