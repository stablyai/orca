import { toast } from 'sonner'
import { absolutePathToFileUri } from '@/components/editor/markdown-internal-links'
import { getConnectionId } from '@/lib/connection-context'
import { useAppStore } from '@/store'
import { findSiblingGroupId } from '@/store/slices/tabs'

export type PreviewableLanguage = 'html'
export const REMOTE_FILE_BROWSER_UNSUPPORTED_MESSAGE =
  'Open in Orca Browser is only available for local files.'

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
  if (getConnectionId(params.worktreeId)) {
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
    // the editor. createEmptySplitGroup returns the new (empty) group id.
    targetGroupId = state.createEmptySplitGroup(worktreeId, sourceGroupId, 'right')
  }
  if (!targetGroupId) {
    return
  }

  const target = getWorkspaceFileBrowserOpenTarget({
    filePath: params.filePath,
    worktreeId
  })
  if (target.status === 'unsupported') {
    toast.error(target.message)
    return
  }

  state.createBrowserTab(worktreeId, target.url, {
    title: target.title,
    targetGroupId,
    activate: true
  })
}
