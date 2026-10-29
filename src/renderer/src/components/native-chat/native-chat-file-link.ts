import { chatWorkspaceByTabId } from '@/lib/structured-chat-tab-index'
import {
  routeNativeChatHref,
  type NativeChatHrefRoute
} from '../../../../shared/native-chat/native-chat-href-routing'
import { WINDOWS_DRIVE_PATH_PREFIX } from '../../../../shared/file-uri-path'
import { normalizeAbsolutePath } from '../../../../shared/terminal-path-normalization'
import {
  parseExplicitFileLinkTarget,
  resolveExplicitFileLinkTarget,
  resolveExplicitFileLinkTargetPath
} from '../../../../shared/explicit-file-link-target'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/worktree-runtime-owner'
import type { AppState } from '@/store/types'
import type { WorktreeRuntimeOwnerState } from '@/lib/worktree-runtime-owner-state'
import {
  resolveNativeChatTabDirectory,
  type NativeChatTabDirectoryState
} from './native-chat-tab-directory'

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

type FileLinkContextInputState = WorktreeRuntimeOwnerState & NativeChatTabDirectoryState

// Every field the directory and owner resolvers read.
const FILE_LINK_CONTEXT_INPUT_KEYS = [
  'repos',
  'settings',
  'worktreesByRepo',
  'detectedWorktreesByRepo',
  'folderWorkspaces',
  'projectGroups',
  'restoredRuntimeHostIdByWorkspaceSessionKey',
  'activeWorktreeId',
  'activeWorkspaceExecutionHostId',
  'runtimeEnvironments',
  'runtimeEnvironmentCatalogHydrated',
  'removedRuntimeEnvironmentIds',
  'floatingWorkspacePath',
  'structuredSessionLaunchDirectoryByTabId'
] as const satisfies readonly (keyof FileLinkContextInputState)[]
type UnlistedInput = Exclude<
  keyof FileLinkContextInputState,
  (typeof FILE_LINK_CONTEXT_INPUT_KEYS)[number] | 'unifiedTabsByWorktree'
>
// Fails to compile when either state type gains a key not listed above; deeper resolver types are not checked.
const allInputsListed: [UnlistedInput] extends [never] ? true : UnlistedInput = true
void allInputsListed

export function createNativeChatFileLinkContextSelector(tabId: string) {
  const selectOwner = createNativeChatTabOwnerSelector(tabId)
  let inputs: unknown[] | null = null
  let context: NativeChatFileLinkContext | null = null
  // Hidden chats still subscribe, so unrelated store writes must not re-resolve directory/owner.
  return (state: NativeChatFileLinkState & Partial<FileLinkContextInputState>) => {
    const owner = selectOwner(state)
    const next = [
      owner,
      state.unifiedTabsByWorktree,
      ...FILE_LINK_CONTEXT_INPUT_KEYS.map((key) => state[key])
    ]
    if (!inputs || next.some((input, index) => input !== inputs?.[index])) {
      inputs = next
      context = resolveNativeChatFileLinkContextForOwner(state, tabId, owner)
    }
    return context
  }
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

// Chats open a drive-letter workspace as native Windows (no WSL mapping), so URL-style /D:/… there is D:.
function routeNativeChatFileHref(
  href: string | undefined,
  worktreePath: string
): NativeChatHrefRoute {
  const route = routeNativeChatHref(href)
  return route.kind === 'file' &&
    WINDOWS_DRIVE_PATH_PREFIX.test(route.pathText) &&
    normalizeAbsolutePath(worktreePath)?.rootKind === 'windows'
    ? { ...route, pathText: route.pathText.slice(1) }
    : route
}

export function resolveNativeChatFileLink(
  href: string | undefined,
  context: NativeChatFileLinkContext | null
): NativeChatResolvedFileLink | null {
  if (!context) {
    return null
  }
  const route = routeNativeChatFileHref(href, context.worktreePath)
  if (route.kind !== 'file') {
    return null
  }
  if (route.pathKind === 'literal') {
    const absolutePath = resolveExplicitFileLinkTargetPath(route.pathText, context.worktreePath)
    return absolutePath ? { absolutePath, line: null, column: null } : null
  }
  return resolvePathText(route.pathText, route.line, context)
}
