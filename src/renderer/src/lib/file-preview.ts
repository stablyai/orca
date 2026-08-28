import { toast } from 'sonner'
import { absolutePathToFileUri } from '@/components/editor/markdown-internal-links'
import { getClientCreationActionPolicy } from '@/lib/client-creation-action-policy'
import { useCallback } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { getConnectionIdForFile } from '@/lib/connection-context'
import { getConnectionIdForFileFromState } from '@/lib/connection-owner-resolution'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { createWebRuntimeSessionBrowserTab } from '@/runtime/web-runtime-session'
import { observeE2eWebRuntimeBrowserCreation } from '@/runtime/web-runtime-browser-creation-e2e-fault'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { findSiblingGroupId } from '@/store/slices/tabs'

export type PreviewableLanguage = 'html'
export const REMOTE_FILE_BROWSER_UNSUPPORTED_MESSAGE =
  'Open in Orca Browser is only available for local files.'
const FILE_BROWSER_OPEN_FAILED_MESSAGE = 'Unable to open this file in Orca Browser.'

type WorkspaceFileBrowserActionMode = 'local-client' | 'paired-runtime' | null

function getWorkspaceFileBrowserActionMode(
  state: AppState,
  worktreeId: string
): WorkspaceFileBrowserActionMode {
  const availability = getClientCreationActionPolicy(state, worktreeId)['managed-browser']
  if (availability.state !== 'enabled') {
    return null
  }
  const environmentId = getRuntimeEnvironmentIdForWorktree(state, worktreeId)
  return environmentId
    ? availability.provider === 'paired-runtime'
      ? 'paired-runtime'
      : null
    : 'local-client'
}

export function canShowWorkspaceFileBrowserAction(
  state: AppState,
  worktreeId: string,
  filePath: string
): boolean {
  const mode = getWorkspaceFileBrowserActionMode(state, worktreeId)
  return mode !== null && getConnectionIdForFileFromState(state, worktreeId, filePath) === null
}

export function useWorkspaceFileBrowserActionPredicate(
  worktreeId: string | null
): (filePath: string) => boolean {
  const inputs = useAppStore(
    useShallow((state) => ({
      mode: worktreeId ? getWorkspaceFileBrowserActionMode(state, worktreeId) : null,
      folderWorkspaces: state.folderWorkspaces,
      projectGroups: state.projectGroups,
      repos: state.repos,
      worktreesByRepo: state.worktreesByRepo
    }))
  )
  return useCallback(
    (filePath: string) =>
      inputs.mode !== null &&
      getConnectionIdForFileFromState(inputs, worktreeId, filePath) === null,
    [inputs, worktreeId]
  )
}

function reportRemoteFileBrowserOpen(result: Promise<boolean>): void {
  observeE2eWebRuntimeBrowserCreation(result)
  void result
    .then((created) => {
      if (!created) {
        toast.error(FILE_BROWSER_OPEN_FAILED_MESSAGE)
      }
    })
    .catch(() => {
      toast.error(FILE_BROWSER_OPEN_FAILED_MESSAGE)
    })
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
    title: params.filePath.split(/[/\\]/).pop() ?? params.filePath
  }
}

export function openFileInBrowserTab(params: {
  filePath: string
  worktreeId: string
}): WorkspaceFileBrowserOpenTarget {
  const target = getWorkspaceFileBrowserOpenTarget(params)
  if (target.status === 'unsupported') {
    return target
  }

  const state = useAppStore.getState()
  const browserAvailability = getClientCreationActionPolicy(state, params.worktreeId)[
    'managed-browser'
  ]
  if (browserAvailability.state !== 'enabled') {
    toast.error(browserAvailability.reason)
    return target
  }
  const environmentId = getRuntimeEnvironmentIdForWorktree(state, params.worktreeId)
  if (environmentId) {
    if (browserAvailability.provider !== 'paired-runtime') {
      toast.error(FILE_BROWSER_OPEN_FAILED_MESSAGE)
      return target
    }
    reportRemoteFileBrowserOpen(
      createWebRuntimeSessionBrowserTab({
        worktreeId: params.worktreeId,
        environmentId,
        url: target.url,
        stagedTitle: target.title,
        stagedFocusAddressBar: false
      })
    )
    return target
  }

  state.createBrowserTab(params.worktreeId, target.url, {
    title: target.title,
    activate: true
  })
  return target
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
  const target = getWorkspaceFileBrowserOpenTarget({
    filePath: params.filePath,
    worktreeId
  })
  if (target.status === 'unsupported') {
    toast.error(target.message)
    return
  }
  const browserAvailability = getClientCreationActionPolicy(state, worktreeId)['managed-browser']
  if (browserAvailability.state !== 'enabled') {
    toast.error(browserAvailability.reason)
    return
  }
  const environmentId = getRuntimeEnvironmentIdForWorktree(state, worktreeId)
  if (environmentId && browserAvailability.provider !== 'paired-runtime') {
    toast.error(FILE_BROWSER_OPEN_FAILED_MESSAGE)
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

  let targetGroupId = existingSibling
  if (!targetGroupId) {
    // Why: no split yet — create one to the right so the preview lands beside
    // the editor. Remote previews stay unfocused until click, so do not activate
    // the empty group or a host snapshot will treat it as a terminal pane.
    targetGroupId = environmentId
      ? state.createEmptySplitGroup(worktreeId, sourceGroupId, 'right', { activate: false })
      : state.createEmptySplitGroup(worktreeId, sourceGroupId, 'right')
  }
  if (!targetGroupId) {
    return
  }

  if (environmentId) {
    reportRemoteFileBrowserOpen(
      createWebRuntimeSessionBrowserTab({
        worktreeId,
        environmentId,
        url: target.url,
        clientTargetGroupId: targetGroupId,
        clientTargetGroupCreated: !existingSibling,
        focusOnCreate: false,
        stagedTitle: target.title,
        stagedFocusAddressBar: false
      })
    )
    return
  }

  state.createBrowserTab(worktreeId, target.url, {
    title: target.title,
    targetGroupId,
    activate: true
  })
}
