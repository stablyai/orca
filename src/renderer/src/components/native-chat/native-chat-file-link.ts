import { chatWorkspaceByTabId } from '@/lib/structured-chat-tab-index'
import { routeNativeChatHref } from '../../../../shared/native-chat-href-routing'
import {
  parseExplicitFileLinkTarget,
  resolveExplicitFileLinkTarget,
  resolveExplicitFileLinkTargetPath
} from '@/lib/explicit-file-link-target'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/worktree-runtime-owner'
import type { AppState } from '@/store/types'
import { resolveNativeChatTabDirectory } from './native-chat-tab-directory'

export type NativeChatFileLinkContext = {
  worktreeId: string
  worktreePath: string
  runtimeEnvironmentId: string | null
  /** The chat's own tab (terminal or agent-session); editor opens place beside its group. */
  sourceTabId?: string
}

export type NativeChatResolvedFileLink = {
  absolutePath: string
  line: number | null
  column: number | null
}

export type NativeChatFileLinkState = Pick<
  AppState,
  | 'detectedWorktreesByRepo'
  | 'folderWorkspaces'
  | 'floatingWorkspacePath'
  | 'projectGroups'
  | 'repos'
  | 'settings'
  | 'tabsByWorktree'
  | 'worktreesByRepo'
> & {
  unifiedTabsByWorktree?: AppState['unifiedTabsByWorktree']
  structuredSessionLaunchDirectoryByTabId?: AppState['structuredSessionLaunchDirectoryByTabId']
}

export function findTerminalTabWorktreeId(
  tabsByWorktree: NativeChatFileLinkState['tabsByWorktree'],
  terminalTabId: string
): string | null {
  return chatWorkspaceByTabId(tabsByWorktree, terminalTabId)
}

/** The workspace that owns a native chat tab, independent of whether its directory is known. */
export function findNativeChatTabOwnerWorktreeId(
  state: Pick<NativeChatFileLinkState, 'tabsByWorktree' | 'unifiedTabsByWorktree'>,
  tabId: string
): string | null {
  return (
    findTerminalTabWorktreeId(state.tabsByWorktree, tabId) ??
    chatWorkspaceByTabId(state.unifiedTabsByWorktree, tabId)
  )
}

export function createNativeChatTabOwnerSelector(tabId: string) {
  let terminalTabs: NativeChatFileLinkState['tabsByWorktree'] | null = null
  let unifiedTabs: NativeChatFileLinkState['unifiedTabsByWorktree']
  let owner: string | null = null
  return (state: Pick<NativeChatFileLinkState, 'tabsByWorktree' | 'unifiedTabsByWorktree'>) => {
    // Hidden chats still subscribe; ownership changes only with the immutable tab maps.
    if (terminalTabs !== state.tabsByWorktree || unifiedTabs !== state.unifiedTabsByWorktree) {
      owner = findNativeChatTabOwnerWorktreeId(state, tabId)
      terminalTabs = state.tabsByWorktree
      unifiedTabs = state.unifiedTabsByWorktree
    }
    return owner
  }
}

export function resolveNativeChatFileLinkContext(
  state: NativeChatFileLinkState,
  terminalTabId: string
): NativeChatFileLinkContext | null {
  return resolveNativeChatFileLinkContextForOwner(
    state,
    terminalTabId,
    findNativeChatTabOwnerWorktreeId(state, terminalTabId)
  )
}

export function createNativeChatFileLinkContextSelector(tabId: string) {
  const selectOwner = createNativeChatTabOwnerSelector(tabId)
  return (state: NativeChatFileLinkState) =>
    resolveNativeChatFileLinkContextForOwner(state, tabId, selectOwner(state))
}

export function resolveNativeChatFileLinkContextForOwner(
  state: Omit<NativeChatFileLinkState, 'tabsByWorktree'>,
  terminalTabId: string,
  worktreeId: string | null
): NativeChatFileLinkContext | null {
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
    runtimeEnvironmentId: runtimeEnvironmentIdOrLocalUnlessTwin(state, worktreeId),
    sourceTabId: terminalTabId
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
  // Explicit agent-authored hrefs bypass automatic terminal-detection filename filters.
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
  if (route.pathKind === 'literal') {
    const absolutePath = resolveExplicitFileLinkTargetPath(route.pathText, context.worktreePath)
    return absolutePath ? { absolutePath, line: null, column: null } : null
  }
  return resolvePathText(route.pathText, route.line, context)
}
