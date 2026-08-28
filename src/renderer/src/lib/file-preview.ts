import { toast } from 'sonner'
import { absolutePathToFileUri } from '@/components/editor/markdown-internal-links'
import { getClientCreationActionPolicy } from '@/lib/client-creation-action-policy'
import { useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { basename, getRelativePathInsideRoot } from '@/lib/path'
import { getConnectionIdForFile } from '@/lib/connection-context'
import { getConnectionIdForFileFromState } from '@/lib/connection-owner-resolution'
import { activateBrowserWorkspaceTab } from '@/lib/browser-workspace-tab-activation'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { findSiblingGroupId } from '@/store/slices/tabs'
import { browserPageDocLocationsEqual } from '../../../shared/browser-page-doc-location'
import { ORCA_BROWSER_BLANK_URL } from '../../../shared/constants'

export type PreviewableLanguage = 'html'
/** Still the answer for flows that need a real `file://` URL (e.g. dropping a file on a browser pane). */
export const REMOTE_FILE_BROWSER_UNSUPPORTED_MESSAGE =
  'Open in Orca Browser is only available for local files.'

/** Localized lazily: a module constant would freeze the language at import time. */
function pairedOutsideWorktreeMessage(): string {
  return translate(
    'auto.lib.file.preview.pairedOutsideWorktree',
    "Files outside the workspace can't be previewed on a paired server yet."
  )
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
  filePath: string
): WorkspaceFilePreviewPlan {
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
    return { status: 'doc-preview' }
  }
  // Why: the doc preview needs no browser at all, so a paired runtime without the
  // screencast capability still previews documents.
  if (getRuntimeEnvironmentIdForWorktree(state, worktreeId)) {
    const worktreeRoot = state.getKnownWorktreeById(worktreeId)?.path ?? null
    if (worktreeRoot && !getRelativePathInsideRoot(filePath, worktreeRoot)) {
      // Why: the host's files.read is worktree-scoped, so this would 404 at request time with
      // nothing telling the user which boundary they hit.
      return {
        status: 'unsupported',
        message: pairedOutsideWorktreeMessage(),
        reason: 'outside-worktree'
      }
    }
    return { status: 'doc-preview' }
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

  state.createBrowserTab(params.worktreeId, plan.url, {
    title: plan.title,
    activate: true
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

  state.createBrowserTab(worktreeId, plan.url, {
    title: plan.title,
    targetGroupId,
    activate: true
  })
}
