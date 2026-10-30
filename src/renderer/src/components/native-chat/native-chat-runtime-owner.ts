import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/worktree-runtime-owner'
import type { WorktreeRuntimeOwnerState } from '@/lib/worktree-runtime-owner-state'
import type { AppState } from '@/store/types'
import {
  createNativeChatTabOwnerSelector,
  findTerminalTabWorktreeId
} from './native-chat-file-link'

export type NativeChatRuntimeOwnerState = Pick<AppState, 'tabsByWorktree'> &
  WorktreeRuntimeOwnerState

/** Resolve runtime ownership from tab/worktree identity even before path hydration; path-coupled file context would wrongly route local (KTD-1). */
export function selectNativeChatRuntimeEnvironmentId(
  state: NativeChatRuntimeOwnerState,
  terminalTabId: string
): string | null {
  return runtimeEnvironmentIdOrLocalUnlessTwin(
    state,
    findTerminalTabWorktreeId(state.tabsByWorktree, terminalTabId)
  )
}

export function createNativeChatRuntimeSelector(terminalTabId: string) {
  const selectOwner = createNativeChatTabOwnerSelector(terminalTabId)
  return (state: NativeChatRuntimeOwnerState): string | null => {
    return runtimeEnvironmentIdOrLocalUnlessTwin(
      state,
      selectOwner({ tabsByWorktree: state.tabsByWorktree })
    )
  }
}
