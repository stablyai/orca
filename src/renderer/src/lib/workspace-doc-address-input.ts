import { isAbsoluteFilesystemPathInput } from '../../../shared/browser-url'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import type { BrowserPageDocLocation } from '../../../shared/browser-workspace-types'
import { getRelativePathInsideRoot, joinPath } from '@/lib/path'
import { getWorkspaceFilePreviewPlan } from '@/lib/file-preview'
import type { AppState } from '@/store/types'
import { htmlFilePathFromUrl } from '../../../shared/html-file-url'
import { authorityKey } from '../../../shared/host-authority'
import { resolveOwner } from './resolve-owner'
import { translate } from '@/i18n/i18n'
import { selectFolderWorkspaces } from '@/store/workspace-record-selectors'

function workspaceHostKey(state: AppState, workspaceId: string): string | null {
  const match = resolveOwner(state, { workspaceId })
  return match.kind === 'resolved' ? authorityKey(match.owner) : null
}

export type WorkspaceDocAddressTarget =
  | { status: 'workspace-doc'; docLocation: BrowserPageDocLocation }
  | { status: 'unsupported'; message: string }
  | { status: 'not-a-workspace-doc' }

/** Only what the doc preview renders. Bare relative input ("docs/x.html") is indistinguishable
 *  from a hostname, so it stays a URL; the explicit ./ prefix is the reader saying "path". */
const PREVIEWABLE_PATH_PATTERN = /\.html?$/i

function ownedWorktreeRoots(
  state: AppState,
  currentWorktreeId: string,
  hostKey: string
): { worktreeId: string; root: string }[] {
  const roots: { worktreeId: string; root: string }[] = []
  for (const worktree of state.allWorktrees()) {
    if (
      worktree.id !== currentWorktreeId &&
      worktree.path &&
      workspaceHostKey(state, worktree.id) === hostKey
    ) {
      roots.push({ worktreeId: worktree.id, root: worktree.path })
    }
  }
  for (const folder of selectFolderWorkspaces(state)) {
    const worktreeId = folderWorkspaceKey(folder.id)
    if (
      worktreeId !== currentWorktreeId &&
      folder.folderPath &&
      workspaceHostKey(state, worktreeId) === hostKey
    ) {
      roots.push({ worktreeId, root: folder.folderPath })
    }
  }
  // After current workspace, prefer the most-specific root so nested files are not attributed to their containing workspace.
  roots.sort((a, b) => b.root.length - a.root.length)
  return roots
}

function planToTarget(
  state: AppState,
  worktreeId: string,
  filePath: string
): WorkspaceDocAddressTarget {
  const plan = getWorkspaceFilePreviewPlan(state, worktreeId, filePath)
  if (plan.status === 'doc-preview') {
    return {
      status: 'workspace-doc',
      docLocation: { kind: 'workspace-doc', worktreeId, filePath }
    }
  }
  if (plan.status === 'unsupported') {
    return { status: 'unsupported', message: plan.message }
  }
  // A local file keeps today's file:// tab; the URL pipeline handles it.
  return { status: 'not-a-workspace-doc' }
}

/** Resolve previewable documents before URL handling turns paths into local file:// that client guests refuse or remote hosts misresolve. Absolute paths try current then known roots; ./ paths use current only. Bare relative text is hostname-ambiguous and stays a URL. */
export function resolveWorkspaceDocAddressTarget(
  state: AppState,
  currentWorktreeId: string,
  rawInput: string
): WorkspaceDocAddressTarget {
  const raw = rawInput.trim()
  const input = htmlFilePathFromUrl(raw) ?? raw
  if (!PREVIEWABLE_PATH_PATTERN.test(input)) {
    return { status: 'not-a-workspace-doc' }
  }
  if (!isAbsoluteFilesystemPathInput(input) && !input.startsWith('./')) {
    return { status: 'not-a-workspace-doc' }
  }
  const hostKey = workspaceHostKey(state, currentWorktreeId)
  if (hostKey === null) {
    return {
      status: 'unsupported',
      message: translate(
        'auto.components.editor.HtmlDocPreview.openExternallyUnknownHostError',
        "Can't open '{{value0}}': the host that owns it is no longer known.",
        { value0: input }
      )
    }
  }
  if (isAbsoluteFilesystemPathInput(input)) {
    // Refuse absolute dot segments too; lexical containment cannot prove the resolved file stays inside.
    if (input.split(/[\\/]+/).some((segment) => segment === '..' || segment === '.')) {
      return { status: 'not-a-workspace-doc' }
    }
    const currentPath = state.getKnownWorktreeById(currentWorktreeId)?.path
    if (currentPath && getRelativePathInsideRoot(input, currentPath)) {
      return planToTarget(state, currentWorktreeId, input)
    }
    for (const { worktreeId, root } of ownedWorktreeRoots(state, currentWorktreeId, hostKey)) {
      if (getRelativePathInsideRoot(input, root)) {
        return planToTarget(state, worktreeId, input)
      }
    }
    // Paths outside known roots still belong to this host; its preview plan checks the boundary.
    return planToTarget(state, currentWorktreeId, input)
  }

  if (input.startsWith('./')) {
    const relative = input.slice(2)
    const root = state.getKnownWorktreeById(currentWorktreeId)?.path ?? null
    if (!root || relative.length === 0) {
      return { status: 'not-a-workspace-doc' }
    }
    // joinPath does not resolve dot segments; lexical checks would accept ./a/../../x.html escaping the workspace.
    if (relative.split(/[\\/]+/).some((segment) => segment === '..' || segment === '.')) {
      return { status: 'not-a-workspace-doc' }
    }
    const filePath = joinPath(root, relative)
    if (!getRelativePathInsideRoot(filePath, root)) {
      return { status: 'not-a-workspace-doc' }
    }
    return planToTarget(state, currentWorktreeId, filePath)
  }

  return { status: 'not-a-workspace-doc' }
}
