import type { BrowserClientHostPlacementPreference } from '../../../shared/browser-client-host-placement'
import { BROWSER_TAB_CREATE_KNOWN_ID_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import { assertRuntimeManagedBrowserCreationAvailable } from '../lib/client-creation-action-policy'
import { createBrowserUuid } from '../lib/browser-uuid'
import { useAppStore } from '../store'
import {
  clearWebSessionFocusIntentIfMatches,
  peekWebSessionFocusIntent,
  recordWebSessionFocusIntent,
  resolveWebSessionVisibleTabId
} from './web-session-focus-intent'
import {
  forgetWebSessionBrowserPlacement,
  markWebSessionBrowserPlacementGroupMaterialized,
  moveWebSessionBrowserPlacement,
  recordWebSessionBrowserPlacement
} from './web-session-browser-placement'
import {
  rehomeStagedWebRuntimeBrowserTab,
  restageWebRuntimeBrowserTabHostingIntent,
  stageWebRuntimeBrowserTab,
  type StagedWebRuntimeBrowserTab
} from './web-runtime-browser-tab-staging'
import { throwIfE2eWebRuntimeBrowserCapabilityUnavailable } from './web-runtime-browser-creation-e2e-fault'
import { expectsBrowserClientHosting } from '../../../shared/browser-client-hosting-eligibility'
import {
  captureRuntimeEnvironmentCall,
  captureWebSessionIntentOwner,
  matchesWebSessionIntentOwner
} from './web-runtime-session-environment'
import { selectWebRuntimeSessionBrowserWorktree } from './web-runtime-session-workspace-selection'

export type CreateWebRuntimeSessionBrowserTabArgs = {
  worktreeId: string
  environmentId?: string | null
  url?: string
  profileId?: string | null
  targetGroupId?: string
  clientTargetGroupId?: string
  clientTargetGroupCreated?: boolean
  focusOnCreate?: boolean
  /** Wait until a renderer-backed host can publish the new page in its session snapshot. */
  waitForRegistration?: boolean
  selectWorktree?: boolean
  stagedTitle?: string
  stagedFocusAddressBar?: boolean
  failureLogMode?: 'details' | 'operation-only'
  placementPreference?: BrowserClientHostPlacementPreference
}

export type WebRuntimeBrowserCreationContext = {
  args: CreateWebRuntimeSessionBrowserTabArgs
  environmentId: string
  intentOwner: ReturnType<typeof captureWebSessionIntentOwner>
  callEnvironment: ReturnType<typeof captureRuntimeEnvironmentCall>
  shouldFocusOnCreate: boolean
  shouldSelectWorktree: boolean
  provisionalPageId: string
  hostSupportsKnownPageId: boolean
  expectsClientHosting: boolean
  unsubscribeFocusGuard: () => void
  guardedPageId: string
  createdPageId: string | null
  createAttempted: boolean
  staged: StagedWebRuntimeBrowserTab | null
  expectedCurrentLocalTabId?: string | null
}

export function createWebRuntimeBrowserCreationContext(
  args: CreateWebRuntimeSessionBrowserTabArgs,
  environmentId: string
): WebRuntimeBrowserCreationContext {
  const intentOwner = captureWebSessionIntentOwner(environmentId)
  const callEnvironment = captureRuntimeEnvironmentCall(environmentId, intentOwner.pairingRevision)
  const shouldFocusOnCreate = args.focusOnCreate !== false
  const provisionalPageId = createBrowserUuid()
  const advertisedCapabilities =
    useAppStore.getState().runtimeStatusByEnvironmentId?.get(environmentId)?.status?.capabilities ??
    []
  const hostSupportsKnownPageId = advertisedCapabilities.includes(
    BROWSER_TAB_CREATE_KNOWN_ID_RUNTIME_CAPABILITY
  )
  // Why the same predicate the main process uses: this mounts the staged pane one round-trip
  // before prepareBrowserClientHostPlacement answers, so the two have to reach the same verdict
  // from the same inputs. A cached status disagreeing with the live one is corrected by
  // restageWebRuntimeBrowserTabHostingIntent below; it never decides the placement itself.
  const expectsClientHosting = expectsBrowserClientHosting({
    enabled: useAppStore.getState().settings?.browserClientHostedRemoteEnabled !== false,
    preference: args.placementPreference,
    deviceScope: useAppStore.getState().runtimeStatusByEnvironmentId?.get(environmentId)?.status
      ?.deviceScope,
    capabilities: advertisedCapabilities
  })
  return {
    args,
    environmentId,
    intentOwner,
    callEnvironment,
    shouldFocusOnCreate,
    shouldSelectWorktree: args.selectWorktree !== false,
    provisionalPageId,
    hostSupportsKnownPageId,
    expectsClientHosting,
    unsubscribeFocusGuard: (): void => {},
    guardedPageId: provisionalPageId,
    createdPageId: null,
    createAttempted: false,
    staged: null
  }
}

export function stageWebRuntimeBrowserCreation(context: WebRuntimeBrowserCreationContext): void {
  const { args, environmentId, intentOwner, provisionalPageId, shouldFocusOnCreate } = context
  throwIfE2eWebRuntimeBrowserCapabilityUnavailable()
  assertRuntimeManagedBrowserCreationAvailable(useAppStore.getState(), environmentId)
  if (args.clientTargetGroupId) {
    recordWebSessionBrowserPlacement({
      environmentId,
      worktreeId: args.worktreeId,
      remotePageId: provisionalPageId,
      groupId: args.clientTargetGroupId,
      callerCreatedGroup: args.clientTargetGroupCreated
    })
  }
  if (context.shouldSelectWorktree) {
    selectWebRuntimeSessionBrowserWorktree(args.worktreeId, environmentId)
  }
  // Why: everything below this point is a host round-trip; stage the tab first so the strip
  // reacts to the click instead of to the runtime.
  context.staged = stageWebRuntimeBrowserTab({
    environmentId,
    worktreeId: args.worktreeId,
    remotePageId: provisionalPageId,
    activate: shouldFocusOnCreate,
    ...(args.url !== undefined ? { url: args.url } : {}),
    ...(args.stagedTitle !== undefined ? { title: args.stagedTitle } : {}),
    ...(args.profileId !== undefined ? { profileId: args.profileId } : {}),
    ...((args.clientTargetGroupId ?? args.targetGroupId)
      ? { targetGroupId: (args.clientTargetGroupId ?? args.targetGroupId) as string }
      : {}),
    ...(args.stagedFocusAddressBar !== undefined
      ? { focusAddressBar: args.stagedFocusAddressBar }
      : {}),
    clientHosted: context.expectsClientHosting
  })
  // Why: sample the focus expectation and arm its guard against the state staging just wrote,
  // before any await. Sampling after the client-host preparation round-trip baked a switch made
  // during it into the baseline, so the guard read the user's new tab as "hasn't moved" and
  // adoption stole focus back.
  const initialFocusState = shouldFocusOnCreate ? useAppStore.getState() : null
  const expectedActiveWorktreeId = initialFocusState?.activeWorktreeId
  const expectedActiveWorkspaceExecutionHostId = initialFocusState?.activeWorkspaceExecutionHostId
  context.expectedCurrentLocalTabId = initialFocusState
    ? resolveWebSessionVisibleTabId(initialFocusState, args.worktreeId)
    : null
  if (shouldFocusOnCreate && matchesWebSessionIntentOwner(intentOwner)) {
    recordWebSessionFocusIntent(
      intentOwner,
      args.worktreeId,
      provisionalPageId,
      undefined,
      context.expectedCurrentLocalTabId
    )
    context.unsubscribeFocusGuard = useAppStore.subscribe((state, previousState) => {
      if (
        state.activeBrowserTabIdByWorktree === previousState.activeBrowserTabIdByWorktree &&
        state.activeFileIdByWorktree === previousState.activeFileIdByWorktree &&
        // Why: resolveWebSessionVisibleTabId now reads group state, so a group-only focus move
        // must re-evaluate it.
        state.activeGroupIdByWorktree === previousState.activeGroupIdByWorktree &&
        state.activeTabIdByWorktree === previousState.activeTabIdByWorktree &&
        state.activeTabType === previousState.activeTabType &&
        state.activeTabTypeByWorktree === previousState.activeTabTypeByWorktree &&
        state.activeWorktreeId === previousState.activeWorktreeId &&
        state.activeWorkspaceExecutionHostId === previousState.activeWorkspaceExecutionHostId &&
        state.groupsByWorktree === previousState.groupsByWorktree &&
        state.unifiedTabsByWorktree === previousState.unifiedTabsByWorktree
      ) {
        return
      }
      if (
        state.activeWorktreeId === expectedActiveWorktreeId &&
        state.activeWorkspaceExecutionHostId === expectedActiveWorkspaceExecutionHostId &&
        resolveWebSessionVisibleTabId(state, args.worktreeId) === context.expectedCurrentLocalTabId
      ) {
        return
      }
      clearWebSessionFocusIntentIfMatches(intentOwner, args.worktreeId, context.guardedPageId)
      context.unsubscribeFocusGuard()
    })
  }
}

export function restageWebRuntimeBrowserCreation(
  context: WebRuntimeBrowserCreationContext,
  clientHosted: boolean
): void {
  if (context.staged) {
    context.staged = restageWebRuntimeBrowserTabHostingIntent(context.staged, {
      environmentId: context.environmentId,
      remotePageId: context.provisionalPageId,
      clientHosted
    })
  }
}

export function rehomeWebRuntimeBrowserCreation(
  context: WebRuntimeBrowserCreationContext,
  remotePageId: string
): void {
  const { args, environmentId, intentOwner, provisionalPageId } = context
  moveWebSessionBrowserPlacement({
    environmentId,
    worktreeId: args.worktreeId,
    fromRemotePageId: provisionalPageId,
    toRemotePageId: remotePageId
  })
  if (context.staged) {
    context.staged = rehomeStagedWebRuntimeBrowserTab(context.staged, {
      environmentId,
      worktreeId: args.worktreeId,
      remotePageId
    })
  }
  const focusIntent = context.shouldFocusOnCreate
    ? peekWebSessionFocusIntent(intentOwner, args.worktreeId)
    : null
  if (focusIntent?.hostTabId === provisionalPageId) {
    recordWebSessionFocusIntent(
      intentOwner,
      args.worktreeId,
      remotePageId,
      undefined,
      focusIntent.expectedCurrentLocalTabId
    )
  }
  context.guardedPageId = remotePageId
}

export function completeWebRuntimeBrowserCreation(context: WebRuntimeBrowserCreationContext): true {
  const { args, environmentId, intentOwner, guardedPageId } = context
  context.staged = null
  const remainingFocusIntent = context.shouldFocusOnCreate
    ? peekWebSessionFocusIntent(intentOwner, args.worktreeId)
    : null
  if (
    remainingFocusIntent?.hostTabId === guardedPageId &&
    remainingFocusIntent.expectedCurrentLocalTabId === context.expectedCurrentLocalTabId
  ) {
    clearWebSessionFocusIntentIfMatches(intentOwner, args.worktreeId, guardedPageId)
  }
  context.unsubscribeFocusGuard()
  if (args.clientTargetGroupId) {
    markWebSessionBrowserPlacementGroupMaterialized({
      worktreeId: args.worktreeId,
      groupId: args.clientTargetGroupId
    })
  }
  forgetWebSessionBrowserPlacement({
    environmentId,
    worktreeId: args.worktreeId,
    remotePageId: guardedPageId
  })
  return true
}
