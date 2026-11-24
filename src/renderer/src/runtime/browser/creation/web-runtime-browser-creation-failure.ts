import { useAppStore } from '../../../store/index'
import { hasRuntimeRpcErrorCode } from '../../../../../shared/remote-runtime/rpc/runtime-rpc-error-code'
import {
  browserCreateFailureCode,
  DEFINITIVE_BROWSER_CREATE_FAILURE_CODES
} from './web-runtime-browser-create-failure-code'
import { recordRendererCrashBreadcrumb } from '@/diagnostics/crash-reporting/crash-breadcrumb-recorder'
import { clearWebSessionFocusIntentIfMatches } from '../../web-session-tabs-sync/navigation/web-session-focus-intent'
import {
  claimWebSessionBrowserPlacementGroupCleanup,
  forgetWebSessionBrowserPlacement,
  releaseWebSessionBrowserPlacementGroup
} from '../placement/web-session-browser-placement'
import {
  discardStagedWebRuntimeBrowserTab,
  StagedWebRuntimeBrowserTabCancelledError
} from './web-runtime-browser-tab-staging'
import type {
  WebRuntimeBrowserCreationContext,
  WebRuntimeBrowserCreationFailureInfo
} from './web-runtime-browser-creation-context'

function isDefinitiveBrowserCreateFailure(error: unknown): boolean {
  return DEFINITIVE_BROWSER_CREATE_FAILURE_CODES.some((code) => hasRuntimeRpcErrorCode(error, code))
}

type WebRuntimeBrowserCreationFailure = {
  cleanupPageId: string | null
  createOutcomeUnknown: boolean
  ownsClientGroupCleanup: boolean
  recoveryError: unknown
}

export function prepareWebRuntimeBrowserCreationFailure(
  context: WebRuntimeBrowserCreationContext,
  error: unknown
): WebRuntimeBrowserCreationFailure {
  const { args, environmentId, guardedPageId } = context
  context.unsubscribeFocusGuard()
  // Unwind optimistic rows before cleanup RPCs so failure leaves no dead tab during browser.tabClose.
  if (context.staged) {
    discardStagedWebRuntimeBrowserTab(context.staged)
  }
  const createFailureDefinitive = isDefinitiveBrowserCreateFailure(error)
  const cleanupPageId =
    context.createdPageId ??
    (context.createAttempted && !createFailureDefinitive && context.hostSupportsKnownPageId
      ? context.provisionalPageId
      : null)
  const createOutcomeUnknown = !cleanupPageId && !createFailureDefinitive
  const ownsClientGroupCleanup = args.clientTargetGroupId
    ? releaseWebSessionBrowserPlacementGroup({
        environmentId,
        worktreeId: args.worktreeId,
        remotePageId: guardedPageId,
        groupId: args.clientTargetGroupId,
        callerCreatedGroup: args.clientTargetGroupCreated === true
      })
    : false
  if (!args.clientTargetGroupId) {
    forgetWebSessionBrowserPlacement({
      environmentId,
      worktreeId: args.worktreeId,
      remotePageId: guardedPageId
    })
  }
  return { cleanupPageId, createOutcomeUnknown, ownsClientGroupCleanup, recoveryError: null }
}

export function finishWebRuntimeBrowserCreationFailure(
  context: WebRuntimeBrowserCreationContext,
  failure: WebRuntimeBrowserCreationFailure,
  error: unknown
): false {
  const { args, intentOwner, guardedPageId } = context
  if (context.shouldFocusOnCreate) {
    clearWebSessionFocusIntentIfMatches(intentOwner, args.worktreeId, guardedPageId)
  }
  if (
    args.clientTargetGroupId &&
    claimWebSessionBrowserPlacementGroupCleanup({
      worktreeId: args.worktreeId,
      groupId: args.clientTargetGroupId,
      ownsGroupCleanup: failure.ownsClientGroupCleanup
    })
  ) {
    useAppStore.getState().closeEmptyGroup(args.worktreeId, args.clientTargetGroupId)
  }
  const cancelled = error instanceof StagedWebRuntimeBrowserTabCancelledError
  // Why: without stage and code a failed link open left only a generic toast (P0 "Unable to open URL").
  const info: WebRuntimeBrowserCreationFailureInfo = {
    stage: context.createdPageId ? 'materialize' : context.createAttempted ? 'create' : 'prepare',
    code: cancelled ? 'closed_before_open' : browserCreateFailureCode(error)
  }
  args.onFailure?.(info)
  if (cancelled) {
    console.warn('[web-runtime-session] browser tab was closed before its create finished')
  } else if (args.failureLogMode === 'operation-only') {
    console.warn(
      `[web-runtime-session] failed to open browser tab at ${info.stage} (${info.code ?? 'no code'})`
    )
    recordRendererCrashBreadcrumb('web_runtime_browser_create_failed', info)
  } else {
    console.warn(
      '[web-runtime-session] failed to create browser tab:',
      error instanceof Error ? error.message : String(error)
    )
  }
  if (failure.recoveryError) {
    throw new Error('The paired runtime could not recover the failed browser creation.', {
      cause: failure.recoveryError
    })
  }
  if (!context.createAttempted) {
    throw error
  }
  if (failure.createOutcomeUnknown) {
    throw new Error('The paired runtime did not confirm whether the browser tab was created.', {
      cause: error
    })
  }
  return false
}
