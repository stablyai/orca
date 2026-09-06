import { useAppStore } from '../store'
import { hasRuntimeRpcErrorCode } from './runtime-rpc-client'
import { clearWebSessionFocusIntentIfMatches } from './web-session-focus-intent'
import {
  claimWebSessionBrowserPlacementGroupCleanup,
  forgetWebSessionBrowserPlacement,
  releaseWebSessionBrowserPlacementGroup
} from './web-session-browser-placement'
import {
  discardStagedWebRuntimeBrowserTab,
  StagedWebRuntimeBrowserTabCancelledError
} from './web-runtime-browser-tab-staging'
import type { WebRuntimeBrowserCreationContext } from './web-runtime-browser-creation-context'

const DEFINITIVE_BROWSER_CREATE_FAILURE_CODES = [
  'browser_error',
  'capability_unsupported',
  'invalid_argument',
  'invalid_params',
  'method_not_found',
  'runtime_rpc_queue_overloaded',
  'selector_ambiguous',
  'selector_not_found',
  'unauthorized'
] as const

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
  // Why: unwind the optimistic tab before the cleanup round-trips below, so a failed create
  // does not leave a dead tab sitting in the strip for the length of browser.tabClose.
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
  if (error instanceof StagedWebRuntimeBrowserTabCancelledError) {
    console.warn('[web-runtime-session] browser tab was closed before its create finished')
  } else if (args.failureLogMode === 'operation-only') {
    console.warn('[web-runtime-session] failed to create browser tab')
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
