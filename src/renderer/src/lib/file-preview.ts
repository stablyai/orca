import { toast } from 'sonner'
import { absolutePathToFileUri } from '@/components/editor/markdown-internal-links'
import { getClientCreationActionPolicy } from '@/lib/client-creation-action-policy'
import { createWebRuntimeSessionBrowserTab } from '@/runtime/web-runtime-session'
import { useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { basename } from '@/lib/path'
import { getConnectionIdForFile } from '@/lib/connection-context'
import { activateBrowserWorkspaceTab } from '@/lib/browser-workspace-tab-activation'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import {
  getWorkspaceFilePreviewPlan,
  REMOTE_FILE_BROWSER_UNSUPPORTED_MESSAGE,
  type WorkspaceFilePreviewPlan
} from '@/lib/workspace-file-preview-plan'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { findSiblingGroupId } from '@/store/slices/tabs'
import { browserPageDocLocationsEqual } from '../../../shared/browser-page-doc-location'
import type { BrowserPageDocLocation } from '../../../shared/browser-workspace-types'
import { findPage } from '@/store/slices/browser-page-records'
import type { BrowserPageConversionLeg } from '@/store/slices/browser-page-conversion'
import { ORCA_BROWSER_BLANK_URL } from '../../../shared/constants'

export type PreviewableLanguage = 'html'
export { getWorkspaceFilePreviewPlan, REMOTE_FILE_BROWSER_UNSUPPORTED_MESSAGE }
export type { WorkspaceFilePreviewPlan }

/** A web client streams the server's initial file navigation; later file navigations are denied. */
function openRuntimeFilePreviewTab(
  plan: Extract<WorkspaceFilePreviewPlan, { status: 'runtime-browser-tab' }>,
  worktreeId: string,
  options: { targetGroupId?: string; activate: boolean; clientTargetGroupCreated?: boolean }
): void {
  const failureMessage = translate(
    'auto.lib.file.preview.runtimeOpenFailed',
    'The paired runtime could not open this file in the browser.'
  )
  void createWebRuntimeSessionBrowserTab({
    worktreeId,
    environmentId: plan.environmentId,
    url: plan.url,
    stagedTitle: plan.title,
    targetGroupId: options.targetGroupId,
    clientTargetGroupId: options.targetGroupId,
    clientTargetGroupCreated: options.clientTargetGroupCreated,
    focusOnCreate: options.activate,
    placementPreference: 'server'
  })
    .then((created) => {
      if (!created) {
        toast.error(failureMessage)
      }
    })
    .catch(() => toast.error(failureMessage))
}

/** Keep known boundary errors actionable so opening the menu can explain them. */
export function canShowWorkspaceFileBrowserAction(
  state: AppState,
  worktreeId: string,
  filePath: string
): boolean {
  const plan = getWorkspaceFilePreviewPlan(state, worktreeId, filePath)
  // Why: an out-of-worktree paired doc keeps its action so activating it can say why it cannot
  // render; hiding the control would leave the limitation unexplained.
  return plan.status !== 'unsupported' || plan.reason === 'outside-worktree'
}

/** Subscribe to owner changes while evaluating the current plan when the action runs. */
export function useWorkspaceFileBrowserActionPredicate(
  worktreeId: string | null
): (filePath: string) => boolean {
  // Why this subscribes but does not decide: visibility must come from the same plan the action
  // itself runs, or the two drift apart — they already disagreed about a local workspace whose
  // managed browser is disabled. The subscription only re-renders the caller; the predicate reads
  // the live store, so it stays identity-stable for the memoized handlers that depend on it.
  useAppStore(
    useShallow((state) => ({
      managedBrowser: worktreeId
        ? getClientCreationActionPolicy(state, worktreeId)['managed-browser'].state
        : null,
      runtimeEnvironmentId: worktreeId
        ? (getRuntimeEnvironmentIdForWorktree(state, worktreeId) ?? null)
        : null,
      folderWorkspaces: state.folderWorkspaces,
      projectGroups: state.projectGroups,
      repos: state.repos,
      worktreesByRepo: state.worktreesByRepo
    }))
  )
  return useCallback(
    (filePath: string) =>
      worktreeId
        ? canShowWorkspaceFileBrowserAction(useAppStore.getState(), worktreeId, filePath)
        : false,
    [worktreeId]
  )
}

export type WorkspaceFileBrowserOpenTarget =
  | {
      status: 'ready'
      url: string
      title: string
    }
  | {
      status: 'unsupported'
      message: string
      reason: 'remote-worktree'
    }

/** `file://` resolution only; remote files have no local path, so this stays local-only. */
export function getWorkspaceFileBrowserOpenTarget(params: {
  filePath: string
  worktreeId: string
}): WorkspaceFileBrowserOpenTarget {
  if (getConnectionIdForFile(params.worktreeId, params.filePath) !== null) {
    // Why: Chromium resolves file:// URLs on the local machine. Remote files
    // need an Orca-served URL before the browser can render them correctly.
    return {
      status: 'unsupported',
      reason: 'remote-worktree',
      message: REMOTE_FILE_BROWSER_UNSUPPORTED_MESSAGE
    }
  }

  return {
    status: 'ready',
    url: absolutePathToFileUri(params.filePath),
    title: basename(params.filePath) || params.filePath
  }
}

/** Reuse an open document before creating another desktop preview grant. */
function openDocPreviewTab(
  state: AppState,
  params: { filePath: string; worktreeId: string; targetGroupId?: string; activate: boolean }
): void {
  const docLocation = {
    kind: 'workspace-doc' as const,
    worktreeId: params.worktreeId,
    filePath: params.filePath
  }
  // Why reuse and not a second tab: previewing a document already on screen is a request to look at
  // it, and two tabs of one document would each hold their own grant on the same file.
  const existing = (state.browserTabsByWorktree[params.worktreeId] ?? []).find((tab) =>
    browserPageDocLocationsEqual(tab.docLocation ?? null, docLocation)
  )
  if (existing) {
    if (
      !params.activate ||
      !activateBrowserWorkspaceTab({ worktreeId: params.worktreeId, workspaceId: existing.id })
    ) {
      state.setActiveBrowserTab(existing.id)
    }
    return
  }
  state.createBrowserTab(params.worktreeId, ORCA_BROWSER_BLANK_URL, {
    docLocation,
    title: basename(params.filePath) || params.filePath,
    targetGroupId: params.targetGroupId,
    // Why explicitly client-local: the document is read through a grant this desktop mints, so the
    // page never belongs to a remote runtime even when the worktree does.
    browserRuntimeEnvironmentId: null,
    // Why the caller decides: opening a file is a request to look at it, while a preview opened to
    // the side belongs beside the source the reader is still working in.
    activate: params.activate
  })
}

/** Open the planned preview and report asynchronous server creation failures. */
export function openFileInBrowserTab(params: {
  filePath: string
  worktreeId: string
}): WorkspaceFilePreviewPlan {
  const state = useAppStore.getState()
  const plan = getWorkspaceFilePreviewPlan(state, params.worktreeId, params.filePath)
  if (plan.status === 'unsupported') {
    return plan
  }
  if (plan.status === 'doc-preview') {
    openDocPreviewTab(state, { ...params, activate: true })
    return plan
  }
  if (plan.status === 'runtime-browser-tab') {
    openRuntimeFilePreviewTab(plan, params.worktreeId, { activate: true })
    return plan
  }

  state.createBrowserTab(params.worktreeId, plan.url, {
    title: plan.title,
    activate: true
  })
  return plan
}

/** The tab a document is already open in, found by every PAGE's docLocation and not just the
 *  workspace mirror — a mixed workspace whose doc page is inactive mirrors null. */
function findWorkspaceShowingDoc(
  state: AppState,
  docLocation: BrowserPageDocLocation
): { workspaceId: string; pageId: string } | null {
  for (const tab of state.browserTabsByWorktree[docLocation.worktreeId] ?? []) {
    const page = (state.browserPagesByWorkspace[tab.id] ?? []).find((candidate) =>
      browserPageDocLocationsEqual(candidate.docLocation ?? null, docLocation)
    )
    if (page) {
      return { workspaceId: tab.id, pageId: page.id }
    }
  }
  return null
}

/**
 * The address bar's way into a workspace document: reuse before converting. A document already on
 * screen is a request to look at it — two tabs of one document would each hold their own grant on
 * the same file — so an existing tab wins and the current page stays what it was; only otherwise
 * does the page convert in place.
 */
export function convertBrowserPageToWorkspaceDoc(
  pageId: string,
  docLocation: BrowserPageDocLocation,
  options?: { leg?: BrowserPageConversionLeg }
): 'activated-existing' | 'opened-in-owning-worktree' | 'converted' | 'failed' {
  const state = useAppStore.getState()
  // Why a history leg skips reuse: Back and Forward both mean "this tab, as it was" — activating
  // another tab showing the document would leave this one a web page with live provenance, so
  // history could jump there forever. A history leg's document was this tab's own, so converting
  // in place is right.
  const isHistoryLeg = options?.leg !== undefined
  const existing = isHistoryLeg ? null : findWorkspaceShowingDoc(state, docLocation)
  if (existing) {
    // Why the worktree switches first: activation is deliberately scoped to the active worktree,
    // so without the switch a cross-worktree reuse would happen entirely out of sight.
    if (state.activeWorktreeId !== docLocation.worktreeId) {
      state.setActiveWorktree(docLocation.worktreeId)
    }
    if (
      !activateBrowserWorkspaceTab({
        worktreeId: docLocation.worktreeId,
        workspaceId: existing.workspaceId
      })
    ) {
      state.setActiveBrowserTab(existing.workspaceId)
    }
    state.setActiveBrowserPage(existing.workspaceId, existing.pageId)
    return 'activated-existing'
  }
  // Why another worktree's document opens a tab there instead of converting this one: a converted
  // page keeps its workspace row, and a row whose worktree differs from its document's can never
  // be the reader's surface under the per-worktree activity slots — its guest would never take
  // focus, and every link in the document would be a dead end.
  const owningPage = findPage(state.browserPagesByWorkspace, pageId)
  if (!isHistoryLeg && owningPage && owningPage.worktreeId !== docLocation.worktreeId) {
    // The reader follows the document to its worktree; opening it out of sight is indistinguishable
    // from nothing having happened.
    if (state.activeWorktreeId !== docLocation.worktreeId) {
      state.setActiveWorktree(docLocation.worktreeId)
    }
    const plan = openFileInBrowserTab({
      filePath: docLocation.filePath,
      worktreeId: docLocation.worktreeId
    })
    if (plan.status === 'unsupported') {
      toast.error(plan.message)
      return 'failed'
    }
    return 'opened-in-owning-worktree'
  }
  return state.convertBrowserPage(pageId, { kind: 'workspace-doc', docLocation }, options)
    ? 'converted'
    : 'failed'
}

export function canPreviewLanguage(language: string): language is PreviewableLanguage {
  return language === 'html'
}

/** Open HTML beside its source in a right split, creating that split when needed. */
export function openFilePreviewToSide(params: {
  language: string
  filePath: string
  worktreeId: string
  sourceGroupId: string | null
}): void {
  if (!canPreviewLanguage(params.language)) {
    return
  }

  const state = useAppStore.getState()
  const worktreeId = params.worktreeId
  const plan = getWorkspaceFilePreviewPlan(state, worktreeId, params.filePath)
  if (plan.status === 'unsupported') {
    toast.error(plan.message)
    return
  }

  // Resolve the group this action originated from. Prefer the caller-supplied
  // id (the tab's own group under split-pane layouts), fall back to the
  // worktree's active group.
  const sourceGroupId =
    params.sourceGroupId ??
    state.activeGroupIdByWorktree[worktreeId] ??
    state.groupsByWorktree[worktreeId]?.[0]?.id ??
    null
  if (!sourceGroupId) {
    return
  }

  const layout = state.layoutByWorktree[worktreeId] ?? null
  const existingSibling = layout ? findSiblingGroupId(layout, sourceGroupId) : null

  // Why the unfocused split on a paired workspace: the preview opens in the background, and a host
  // snapshot reads an activated empty group as a terminal pane.
  const targetGroupId =
    existingSibling ??
    (getRuntimeEnvironmentIdForWorktree(state, worktreeId)
      ? state.createEmptySplitGroup(worktreeId, sourceGroupId, 'right', { activate: false })
      : state.createEmptySplitGroup(worktreeId, sourceGroupId, 'right'))
  if (!targetGroupId) {
    return
  }

  if (plan.status === 'doc-preview') {
    openDocPreviewTab(state, {
      filePath: params.filePath,
      worktreeId,
      targetGroupId,
      activate: false
    })
    return
  }

  if (plan.status === 'runtime-browser-tab') {
    openRuntimeFilePreviewTab(plan, worktreeId, {
      targetGroupId,
      activate: false,
      clientTargetGroupCreated: !existingSibling
    })
    return
  }

  state.createBrowserTab(worktreeId, plan.url, {
    title: plan.title,
    targetGroupId,
    activate: true
  })
}
