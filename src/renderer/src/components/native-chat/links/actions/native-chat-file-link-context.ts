import { runtimeEnvironmentIdOrLocalUnlessTwin } from '../../../../lib/workspace/ownership/worktree-runtime-owner'
import type { AppState } from '../../../../store/types'
import type { WorktreeRuntimeOwnerState } from '../../../../lib/workspace/ownership/worktree-runtime-owner-state'
import {
  resolveNativeChatTabDirectory,
  type NativeChatTabDirectoryState
} from '../../pane/routing/native-chat-tab-directory'

import {
  findNativeChatTabOwnerWorktreeId,
  createNativeChatTabOwnerSelector
} from '../../pane/ownership/native-chat-tab-owner'

export type NativeChatFileLinkContext = {
  worktreeId: string
  worktreePath: string
  runtimeEnvironmentId: string | null
  /** The chat's own tab (terminal or agent-session); editor opens place beside its group. */
  sourceTabId?: string
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
export const FILE_LINK_CONTEXT_INPUT_KEYS = [
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
  'floatingWorkspacePath'
] as const satisfies readonly (keyof FileLinkContextInputState)[]

type UnlistedInput = Exclude<
  keyof FileLinkContextInputState,
  | (typeof FILE_LINK_CONTEXT_INPUT_KEYS)[number]
  | 'unifiedTabsByWorktree'
  | 'structuredSessionLaunchDirectoryByTabId'
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
      // Why: only this tab's pin; the bridge publishes one pin per write across every chat.
      state.structuredSessionLaunchDirectoryByTabId?.[tabId],
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
