import { routeNativeChatHref } from '../../../../shared/native-chat-href-routing'
import {
  parseExplicitFileLinkTarget,
  resolveExplicitFileLinkTarget
} from '@/lib/explicit-file-link-target'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import type { AppState } from '@/store/types'
import { resolveNativeChatTabDirectory } from './native-chat-tab-directory'

export type NativeChatFileLinkContext = {
  worktreeId: string
  worktreePath: string
  runtimeEnvironmentId: string | null
}

export type NativeChatResolvedFileLink = {
  absolutePath: string
  line: number | null
  column: number | null
}

type NativeChatFileLinkState = Pick<
  AppState,
  | 'folderWorkspaces'
  | 'getKnownWorktreeById'
  | 'projectGroups'
  | 'repos'
  | 'settings'
  | 'tabsByWorktree'
  | 'worktreesByRepo'
> & {
  unifiedTabsByWorktree?: AppState['unifiedTabsByWorktree']
  floatingWorkspacePath?: AppState['floatingWorkspacePath']
  structuredSessionWorkspacePathByTabId?: AppState['structuredSessionWorkspacePathByTabId']
}

export function findTerminalTabWorktreeId(
  tabsByWorktree: NativeChatFileLinkState['tabsByWorktree'],
  terminalTabId: string
): string | null {
  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    // Why: tabsByWorktree stores TerminalTab records; unified tabs carry
    // entityId, but the terminal owner lookup must use the backing tab id.
    if (tabs.some((tab) => tab.id === terminalTabId)) {
      return worktreeId
    }
  }
  return null
}

function findStructuredTabWorktreeId(
  unifiedTabsByWorktree: NativeChatFileLinkState['unifiedTabsByWorktree'],
  tabId: string
): string | null {
  for (const [worktreeId, tabs] of Object.entries(unifiedTabsByWorktree ?? {})) {
    if (tabs.some((tab) => tab.id === tabId && tab.contentType === 'agent-session')) {
      return worktreeId
    }
  }
  return null
}

/** The workspace that owns a native chat tab, independent of whether its directory is known. */
export function findNativeChatTabOwnerWorktreeId(
  state: Pick<NativeChatFileLinkState, 'tabsByWorktree' | 'unifiedTabsByWorktree'>,
  tabId: string
): string | null {
  return (
    findTerminalTabWorktreeId(state.tabsByWorktree, tabId) ??
    findStructuredTabWorktreeId(state.unifiedTabsByWorktree, tabId)
  )
}

export function resolveNativeChatFileLinkContext(
  state: NativeChatFileLinkState,
  terminalTabId: string
): NativeChatFileLinkContext | null {
  const worktreeId = findNativeChatTabOwnerWorktreeId(state, terminalTabId)
  if (!worktreeId) {
    return null
  }
  const worktreePath = resolveNativeChatTabDirectory(state, terminalTabId, worktreeId)
  if (!worktreePath) {
    return null
  }

  return {
    worktreeId,
    worktreePath,
    runtimeEnvironmentId: getRuntimeEnvironmentIdForWorktree(state, worktreeId)
  }
}

function resolvePathText(
  pathText: string,
  fallbackLine: number | null,
  context: NativeChatFileLinkContext
): NativeChatResolvedFileLink | null {
  const parsed = parseExplicitFileLinkTarget(pathText, { allowRelativeDirectoryPath: true })
  if (!parsed) {
    return null
  }
  // Native chat hrefs are explicit agent-authored links, so avoid the terminal
  // detector's conservative extension/filename filters.
  const resolved = resolveExplicitFileLinkTarget(parsed, context.worktreePath)
  if (!resolved) {
    return null
  }
  return {
    absolutePath: resolved.absolutePath,
    line: resolved.line ?? fallbackLine,
    column: resolved.column
  }
}

export function resolveNativeChatFileLink(
  href: string | undefined,
  context: NativeChatFileLinkContext | null
): NativeChatResolvedFileLink | null {
  if (!context) {
    return null
  }
  const route = routeNativeChatHref(href)
  if (route.kind !== 'file') {
    return null
  }
  return resolvePathText(route.pathText, route.line, context)
}
