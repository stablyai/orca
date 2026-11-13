import { useAppStore } from '@/store/index'
import { getExecutionHostIdForWorktree } from '@/lib/workspace/ownership/worktree-runtime-owner'
import { parseExecutionHostId } from '../../../../../shared/execution-host'
import {
  beginWebRuntimeInitialTerminalBootstrap,
  endWebRuntimeInitialTerminalBootstrap
} from '@/runtime/web-session-tabs-sync/initial-terminal/web-runtime-initial-terminal-bootstrap'

/**
 * CLOUD-CHAT-FIRST-TAB: a create on a paired host (an Orca Cloud VM) whose first agent opens as a
 * chat claims the workspace's initial-terminal bootstrap while that chat launches, like the
 * after-wake first agent does. Without it the mirror's first empty frame seeds a plain shell,
 * activated, in front of the chat. Released once the launch has answered: by then the chat tab
 * counts as the workspace's first surface, and a launch that opened nothing gets its shell.
 */
export function claimFirstSurfaceForStructuredCreate(worktreeId: string): () => void {
  const host = parseExecutionHostId(
    getExecutionHostIdForWorktree(useAppStore.getState(), worktreeId)
  )
  if (host?.kind !== 'runtime') {
    return () => undefined
  }
  const { environmentId } = host
  if (!beginWebRuntimeInitialTerminalBootstrap(environmentId, worktreeId)) {
    // Someone else's create is already in flight; it owns the release.
    return () => undefined
  }
  let released = false
  return () => {
    if (!released) {
      released = true
      endWebRuntimeInitialTerminalBootstrap(environmentId, worktreeId)
    }
  }
}
