import { openPlannedFileBrowserLink, type FileBrowserLinkTarget } from './file-preview-link-open'
import type { BrowserLinkOpenContext, BrowserOpenOutcome } from './browser-link-destination'
import { toast } from 'sonner'
import { absolutePathToFileUri } from '@/components/editor/markdown-internal-links'
import { getWorkspaceClientCreationActionPolicy } from '@/lib/client-creation-action-policy'
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
  const availability = getWorkspaceClientCreationActionPolicy(state, worktreeId)['managed-browser']
  if (availability.state !== 'enabled') {
    return { status: 'unsupported', message: availability.reason, reason: 'no-channel' }
  }
  return {
    status: 'browser-tab',
    url: absolutePathToFileUri(filePath),
    title: basename(filePath) || filePath
  }
}

/** Use embedded browser tabs locally; remote documents require this desktop’s granted orca-preview scheme because client guests refuse file: and local file URLs would read the wrong machine. */
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
    // Unresolved ownership cannot choose a channel; local fallback would read a remote path on this machine.
    return {
      status: 'unsupported',
      message: REMOTE_FILE_BROWSER_UNSUPPORTED_MESSAGE,
      reason: 'no-channel'
    }
  }
  if (connectionId !== null) {
    return webClientDocPreviewRefusal() ?? { status: 'doc-preview' }
  }
  // Document preview needs no remote browser/screencast capability.
  if (runtimeEnvironmentIdOrLocalUnlessTwin(state, worktreeId)) {
    const worktreeRoot = state.getKnownWorktreeById(worktreeId)?.path ?? null
    const outsideWorktree = worktreeRoot && !getRelativePathInsideRoot(filePath, worktreeRoot)
    // Paired files.read is bounded to worktrees/chat scratch roots; explain out-of-root paths before they become preview 404s.
    if (outsideWorktree && !chatScratchFileAddress(filePath)) {
      return {
        status: 'unsupported',
        message: pairedOutsideWorktreeMessage(),
        reason: 'outside-worktree'
      }
    }
    return webClientDocPreviewRefusal() ?? { status: 'doc-preview' }
  }
  const availability = getWorkspaceClientCreationActionPolicy(state, worktreeId)['managed-browser']
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
  // Keep unsupported paired-path actions visible so activation can explain their workspace boundary.
  return plan.status !== 'unsupported' || plan.reason === 'outside-worktree'
}

export function useWorkspaceFileBrowserActionPredicate(
  worktreeId: string | null
): (filePath: string) => boolean {
  // Subscribe only to trigger rerenders; use the action’s live plan for visibility so the rules cannot drift and handlers retain stable identity.
  useAppStore(
    useShallow((state) => ({
      managedBrowser: worktreeId
        ? getWorkspaceClientCreationActionPolicy(state, worktreeId)['managed-browser'].state
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
  // Reuse the document’s tab; opening another would mint a second grant for the same file.
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
    // The preview grant is minted on this desktop, so the page stays explicitly client-local even for remote worktrees.
    browserRuntimeEnvironmentId: null,
    // Foreground file opens follow the reader; side previews must leave their source visible.
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

// Use/create the group to the right so side preview keeps the source editor visible.
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

  // Use the originating tab’s group, falling back to the workspace’s active group.
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

  // Keep paired side splits unfocused; host snapshots interpret activated empty groups as terminals.
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
