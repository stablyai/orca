import type { AppState } from '@/store/types'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { getExecutionHostIdForWorktree } from '@/lib/worktree-runtime-owner'
import { getRendererAppPlatform } from '@/lib/renderer-app-platform'

export function canUseStructuredNativeChat(state: AppState, worktreeId: string): boolean {
  if (state.settings?.experimentalStructuredNativeChat !== true) {
    return false
  }
  // Structured chat has no entry path of its own — it reuses the Chat UI default view. With
  // Terminal chat selected the toggle is hidden but its persisted value survives, so gate on the
  // default view too or a stale `true` would silently route new tabs into the structured runtime.
  if (state.settings?.openAgentTabsInChatByDefault !== true) {
    return false
  }
  if (getExecutionHostIdForWorktree(state, worktreeId) !== 'local') {
    return false
  }
  // The shipped Windows process-tree addon may not expose creation time. Until
  // the host advertises that proof, refuse every local Windows execution path —
  // windows-host, WSL, and keys that resolve no project runtime (folder
  // workspaces, floating terminal) — so create cannot fail after the click.
  if (getRendererAppPlatform() === 'win32') {
    return false
  }
  // Refuse WSL and repair-required runtimes even if resolution ever runs
  // off-win32; the gate must not depend on the resolver's platform guard.
  const projectRuntime = getLocalProjectExecutionRuntimeContext(state, worktreeId)
  return !(projectRuntime?.status === 'repair-required' || projectRuntime?.runtime.kind === 'wsl')
}
