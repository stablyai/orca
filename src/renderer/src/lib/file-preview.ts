import { openPlannedFileBrowserLink, type FileBrowserLinkTarget } from './file-preview-link-open'
import type { BrowserLinkOpenContext, BrowserOpenOutcome } from './browser-link-destination'
import { toast } from 'sonner'
import { absolutePathToFileUri } from '@/components/editor/markdown-internal-links'
import { getClientCreationActionPolicy } from '@/lib/client-creation-action-policy'
import { webClientDocPreviewRefusal } from '@/lib/doc-preview-web-client'
import { useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { basename, getRelativePathInsideRoot } from '@/lib/path'
import { getConnectionIdForFileFromState } from '@/lib/connection-owner-resolution'
import { activateBrowserWorkspaceTab } from '@/lib/browser-workspace-tab-activation'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/worktree-runtime-owner'
import { isTwinWorkspace } from '@/lib/resolve-owner'
import {
  REMOTE_FILE_BROWSER_UNSUPPORTED_MESSAGE,
  TWIN_FILE_BROWSER_UNSUPPORTED_MESSAGE
} from '@/lib/workspace-file-browser-open-target'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { findSiblingGroupId } from '@/store/slices/tabs'
import type { CreateBrowserTabOptions } from '@/store/slices/browser/browser-slice-contract'
import { ORCA_BROWSER_BLANK_URL } from '../../../shared/constants'
import { chatScratchFileAddress } from '@/runtime/runtime-chat-scratch-file-address'
import { selectFolderWorkspaces, selectWorktreesByRepo } from '@/store/workspace-record-selectors'
import { findWorkspaceShowingDoc } from './file-preview-page-conversion'

export { convertBrowserPageToWorkspaceDoc } from './file-preview-page-conversion'

export type PreviewableLanguage = 'html'

/** Localized lazily: a module constant would freeze the language at import time. */
function pairedOutsideWorktreeMessage(): string {
  return translate(
    'auto.lib.file.preview.pairedOutsideWorktree',
    "Files outside the workspace can't be previewed on a paired server yet."
  )
}

function getLocalFilePreviewPlan(
  state: AppState,
  worktreeId: string,
  filePath: string
): WorkspaceFilePreviewPlan {
  const availability = getClientCreationActionPolicy(state, worktreeId)['managed-browser']
  if (availability.state !== 'enabled') {
    return { status: 'unsupported', message: availability.reason, reason: 'no-channel' }
  }
  return {
    status: 'browser-tab',
    url: absolutePathToFileUri(filePath),
    title: basename(filePath) || filePath
  }
}

/**
 * How a previewable document should be rendered.
 *
 * `browser-tab` keeps local workspaces on the pre-existing embedded browser tab.
 * `doc-preview` renders the document locally from the owning workspace's disk
 * over the `orca-preview` scheme, which is the only option for SSH and paired
 * workspaces: client-hosted browser guests refuse `file:` by design, and a
 * `file://` URL would resolve on the wrong machine anyway.
 */
export type WorkspaceFilePreviewPlan =
  | { status: 'browser-tab'; url: string; title: string }
  | { status: 'doc-preview' }
  | { status: 'unsupported'; message: string; reason: 'no-channel' | 'outside-worktree' }

export function getWorkspaceFilePreviewPlan(
  state: AppState,
  worktreeId: string,
  filePath: string,
  clientLocal = false
): WorkspaceFilePreviewPlan {
  if (clientLocal) {
    return getLocalFilePreviewPlan(state, worktreeId, filePath)
  }
  // Why: a twin reads as "no server" below, which would open this machine's copy of the path.
  if (isTwinWorkspace(state, worktreeId)) {
    return {
      status: 'unsupported',
      message: TWIN_FILE_BROWSER_UNSUPPORTED_MESSAGE,
      reason: 'no-channel'
    }
  }
  const connectionId = getConnectionIdForFileFromState(state, worktreeId, filePath)
  if (connectionId === undefined) {
    // Why: an unresolved owner can't pick a channel — reading it locally would hand a
    // remote path to this machine's filesystem.
    return {
      status: 'unsupported',
      message: REMOTE_FILE_BROWSER_UNSUPPORTED_MESSAGE,
      reason: 'no-channel'
    }
  }
  if (connectionId !== null) {
    return webClientDocPreviewRefusal() ?? { status: 'doc-preview' }
  }
  // Why: the doc preview needs no browser at all, so a paired runtime without the
  // screencast capability still previews documents.
  if (runtimeEnvironmentIdOrLocalUnlessTwin(state, worktreeId)) {
    const worktreeRoot = state.getKnownWorktreeById(worktreeId)?.path ?? null
    const outsideWorktree = worktreeRoot && !getRelativePathInsideRoot(filePath, worktreeRoot)
    // Why: the host's files.read is worktree-scoped (plus chat scratch folders, served by path), so
    // this would 404 at request time with nothing telling the user which boundary they hit.
    if (outsideWorktree && !chatScratchFileAddress(filePath)) {
      return {
        status: 'unsupported',
        message: pairedOutsideWorktreeMessage(),
        reason: 'outside-worktree'
      }
    }
    return webClientDocPreviewRefusal() ?? { status: 'doc-preview' }
  }
  const availability = getClientCreationActionPolicy(state, worktreeId)['managed-browser']
  if (availability.state !== 'enabled') {
    return { status: 'unsupported', message: availability.reason, reason: 'no-channel' }
  }
  return {
    status: 'browser-tab',
    url: absolutePathToFileUri(filePath),
    title: basename(filePath) || filePath
  }
}

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
        ? runtimeEnvironmentIdOrLocalUnlessTwin(state, worktreeId)
        : null,
      folderWorkspaces: selectFolderWorkspaces(state),
      projectGroups: state.projectGroups,
      repos: state.repos,
      worktreesByRepo: selectWorktreesByRepo(state)
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

function openDocPreviewTab(
  state: AppState,
  params: { filePath: string; worktreeId: string; activate: boolean },
  placement?: Pick<CreateBrowserTabOptions, 'targetGroupId' | 'split'>
): void {
  const docLocation = {
    kind: 'workspace-doc' as const,
    worktreeId: params.worktreeId,
    filePath: params.filePath
  }
  // Why reuse and not a second tab: previewing a document already on screen is a request to look at
  // it, and two tabs of one document would each hold their own grant on the same file.
  const existing = findWorkspaceShowingDoc(state, docLocation)
  if (existing) {
    if (
      !params.activate ||
      !activateBrowserWorkspaceTab({
        worktreeId: params.worktreeId,
        ...existing
      })
    ) {
      state.setActiveBrowserTab(existing.workspaceId)
      state.setActiveBrowserPage(existing.workspaceId, existing.pageId)
    }
    return
  }
  state.createBrowserTab(params.worktreeId, ORCA_BROWSER_BLANK_URL, {
    docLocation,
    title: basename(params.filePath) || params.filePath,
    ...placement,
    // Why explicitly client-local: the document is read through a grant this desktop mints, so the
    // page never belongs to a remote runtime even when the worktree does.
    browserRuntimeEnvironmentId: null,
    // Why the caller decides: opening a file is a request to look at it, while a preview opened to
    // the side belongs beside the source the reader is still working in.
    activate: params.activate
  })
}

export function openFileInBrowserTab(
  params: FileBrowserLinkTarget & {
    targetGroupId?: string
    clientLocal?: boolean
    linkContext?: BrowserLinkOpenContext
    onLinkOutcome?: (outcome: BrowserOpenOutcome) => void
  }
): WorkspaceFilePreviewPlan {
  const state = useAppStore.getState()
  const plan = getWorkspaceFilePreviewPlan(
    state,
    params.worktreeId,
    params.filePath,
    params.clientLocal
  )
  if (plan.status === 'unsupported') {
    params.onLinkOutcome?.({ status: 'unsupported' })
    return plan
  }
  if (params.linkContext) {
    void openPlannedFileBrowserLink(state, params, plan, params.linkContext, (current) => {
      const currentPlan = getWorkspaceFilePreviewPlan(
        current,
        params.worktreeId,
        params.filePath,
        params.clientLocal
      )
      return (
        currentPlan.status === plan.status &&
        (currentPlan.status !== 'browser-tab' ||
          (plan.status === 'browser-tab' && currentPlan.url === plan.url))
      )
    }).then((outcome) => params.onLinkOutcome?.(outcome))
    return plan
  }
  if (plan.status === 'doc-preview') {
    openDocPreviewTab(state, { ...params, activate: true }, { targetGroupId: params.targetGroupId })
    return plan
  }

  state.createBrowserTab(params.worktreeId, plan.url, {
    title: plan.title,
    ...(params.targetGroupId ? { targetGroupId: params.targetGroupId } : {}),
    activate: true,
    ...(params.clientLocal ? { browserRuntimeEnvironmentId: null } : {})
  })
  return plan
}

export function canPreviewLanguage(language: string): language is PreviewableLanguage {
  return language === 'html'
}

// Why: "Open Preview to the Side" mirrors the VS Code pattern — the rendered
// view goes into the group to the right of the editor, creating a right split
// if one doesn't already exist. Keeps the editor source visible alongside the
// preview instead of replacing the active tab.
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
  const activate = !runtimeEnvironmentIdOrLocalUnlessTwin(state, worktreeId)
  const placement = existingSibling
    ? { targetGroupId: existingSibling }
    : { split: { sourceGroupId, splitDirection: 'right' as const, activate } }

  if (plan.status === 'doc-preview') {
    openDocPreviewTab(state, { filePath: params.filePath, worktreeId, activate: false }, placement)
    return
  }

  state.createBrowserTab(worktreeId, plan.url, {
    title: plan.title,
    ...placement,
    activate: true
  })
}
