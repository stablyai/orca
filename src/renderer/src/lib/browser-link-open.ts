import { focusOpenedBrowserLink } from './browser-link-focus'
import { releaseBrowserPageMount } from '@/components/browser-pane/host-guest/browser-page-mount-admission'
import { createBrowserLinkHostMatcher } from './browser-link-owner'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import type { CreateBrowserTabOptions } from '@/store/slices/browser/browser-slice-contract'
import { activateBrowserWorkspaceTab } from './browser-workspace-tab-activation'
import {
  browserLinkPageMatches,
  currentBrowserLinkMatch,
  browserOpenResultForPage,
  selectBrowserLinkDestination,
  type BrowserLinkDestination,
  type BrowserLinkOpenContext,
  type BrowserOpenOutcome
} from './browser-link-destination'
import { isLiveLinkOpenGroup } from './link-open-intent'
import { afterPendingEntityTabs, hasPendingEntityTab } from '@/runtime/layout-owner-pending-tabs'
import { captureBrowserLinkReveal } from './browser-link-reveal'

export class BrowserLinkPlacementRefused extends Error {}

export function browserLinkCommitIsValid(
  state: AppState,
  destination: BrowserLinkDestination,
  context: BrowserLinkOpenContext,
  groupId: string | undefined,
  ownsRoute: (state: AppState) => boolean
): boolean {
  if (context.isCurrentRequest?.() === false || !ownsRoute(state)) {
    return false
  }
  if (groupId && !isLiveLinkOpenGroup(state, destination.worktreeId, groupId)) {
    return false
  }
  const intent = context.linkIntent
  const matchesHost = createBrowserLinkHostMatcher(
    state,
    destination.worktreeId,
    destination.executionHostId
  )
  if (
    intent?.workspaceId === destination.worktreeId &&
    intent.hostId &&
    !matchesHost(intent.hostId)
  ) {
    return false
  }
  return (
    !intent?.targetGroupId ||
    (intent.workspaceId === destination.worktreeId &&
      matchesHost(intent.hostId) &&
      intent.targetGroupId === groupId)
  )
}

/** Selection and creation run together; activation waits for main to draw the tab. */
export async function openLocalBrowserLink(params: {
  destination: BrowserLinkDestination
  context: BrowserLinkOpenContext
  url: string
  options?: CreateBrowserTabOptions
  ownsRoute: (state: AppState) => boolean
  reveal?: () => void
}): Promise<BrowserOpenOutcome> {
  const { destination, context } = params
  if (context.isCurrentRequest?.() === false) {
    return { status: 'superseded' }
  }
  const state = useAppStore.getState()
  const selection = selectBrowserLinkDestination(state, destination, context.linkIntent)
  if (selection.status === 'refused') {
    return selection
  }
  const reveal = captureBrowserLinkReveal(
    useAppStore.getState,
    useAppStore.subscribe,
    context.canReveal
  )
  const validate = (current: AppState): void => {
    if (
      !browserLinkCommitIsValid(
        current,
        destination,
        context,
        selection.groupId ?? selection.split?.sourceGroupId,
        params.ownsRoute
      )
    ) {
      throw new BrowserLinkPlacementRefused('The browser link destination is no longer available.')
    }
  }
  let createdTabId: string | undefined
  let createdPageId: string | undefined
  let retainCreatedTab = false
  try {
    validate(state)
    let result = selection.match
    if (result) {
      const match = result
      const workspace = (state.browserTabsByWorktree[destination.worktreeId] ?? []).find(
        (item) => item.id === match.browserWorkspaceId
      )
      const page = (state.browserPagesByWorkspace[match.browserWorkspaceId] ?? []).find(
        (item) => item.id === match.browserPageId
      )
      if (!workspace || !page || !browserLinkPageMatches(state, destination, workspace, page)) {
        return { status: 'refused' }
      }
    } else {
      const created = state.createBrowserTab(destination.worktreeId, params.url, {
        ...params.options,
        targetGroupId: selection.groupId,
        ...(selection.split ? { split: selection.split } : {}),
        executionHostId: destination.executionHostId,
        browserRuntimeEnvironmentId: destination.browserRuntimeEnvironmentId,
        sessionProfileId: destination.sessionProfileId,
        sessionPartition: destination.sessionPartition,
        activate: false,
        focusAddressBar: false,
        validateLinkPlacement: validate
      })
      createdTabId = created.id
      createdPageId = created.activePageId ?? undefined
      if (hasPendingEntityTab(destination.worktreeId, created.id)) {
        await new Promise<void>((resolve) =>
          afterPendingEntityTabs(destination.worktreeId, created.id, resolve)
        )
      }
      validate(useAppStore.getState())
      const pageId = created.activePageId
      result = pageId
        ? browserOpenResultForPage(useAppStore.getState(), destination, created.id, pageId)
        : null
    }
    if (!result) {
      return { status: 'failed' }
    }
    if (context.linkIntent?.targetGroupId && result.groupId !== context.linkIntent.targetGroupId) {
      return { status: 'refused' }
    }
    validate(useAppStore.getState())
    if (params.options?.activate === false || !reveal.canReveal()) {
      retainCreatedTab = true
      return { status: 'opened', result }
    }
    params.reveal?.()
    const current = useAppStore.getState()
    validate(current)
    const actual = browserOpenResultForPage(
      current,
      destination,
      result.browserWorkspaceId,
      result.browserPageId
    )
    if (
      !actual ||
      (context.linkIntent?.targetGroupId && actual.groupId !== context.linkIntent.targetGroupId)
    ) {
      return { status: 'refused' }
    }
    if (selection.match && !currentBrowserLinkMatch(current, destination, actual)) {
      return { status: 'refused' }
    }
    if (
      !activateBrowserWorkspaceTab({
        worktreeId: actual.worktreeId,
        workspaceId: actual.browserWorkspaceId,
        pageId: actual.browserPageId,
        executionHostId: actual.executionHostId
      })
    ) {
      return { status: 'refused' }
    }
    focusOpenedBrowserLink(actual)
    retainCreatedTab = true
    return { status: 'opened', result: actual }
  } catch (error) {
    if (context.isCurrentRequest?.() === false) {
      return { status: 'superseded' }
    }
    if (error instanceof BrowserLinkPlacementRefused) {
      return { status: 'refused' }
    }
    return { status: 'failed' }
  } finally {
    reveal.dispose()
    if (createdTabId && !retainCreatedTab) {
      if (createdPageId) {
        releaseBrowserPageMount(createdPageId)
      }
      useAppStore.getState().closeBrowserTab(createdTabId, { reason: 'cleanup' })
    }
  }
}
