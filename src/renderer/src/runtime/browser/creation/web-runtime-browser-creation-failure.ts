import { useAppStore } from '../../../store/index'
import {
  hasRuntimeRpcErrorCode,
  readRuntimeRpcErrorCode
} from '../../../../../shared/remote-runtime/rpc/runtime-rpc-error-code'
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

// Codes a browser create can fail with; any other host-supplied code is logged as other_code.
const REPORTED_BROWSER_CREATE_FAILURE_CODES = [
  ...DEFINITIVE_BROWSER_CREATE_FAILURE_CODES,
  'browser_unavailable',
  'browser_profile_unavailable',
  'browser_owner_unavailable',
  'browser_command_unavailable',
  'browser_tab_not_found',
  'browser_timeout',
  'runtime_compat_block',
  'runtime_unavailable',
  'runtime_error'
]

/** The failure's known machine code (never its message, which can name the URL). */
export function browserCreateFailureCode(error: unknown): string | null {
  return readRuntimeRpcErrorCode(error, REPORTED_BROWSER_CREATE_FAILURE_CODES)
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
  if (error instanceof StagedWebRuntimeBrowserTabCancelledError) {
    console.warn('[web-runtime-session] browser tab was closed before its create finished')
  } else if (args.failureLogMode === 'operation-only') {
    // Why the code: without it a failed link open left only a generic toast (P0 "Unable to open URL").
    const code = browserCreateFailureCode(error)
    args.onFailureCode?.(code)
    console.warn(`[web-runtime-session] failed to create browser tab (${code ?? 'no code'})`)
    recordRendererCrashBreadcrumb('web_runtime_browser_create_failed', {
      code,
      createAttempted: context.createAttempted
    })
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
