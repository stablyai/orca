import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { activateAndRevealWorktree } from '@/lib/workspace/activation/worktree-activation'
import { createForkWorktree, forkableWorktreeBranch } from '@/lib/workspace/creation/fork-worktree'
import type { TuiAgent } from '../../../../../../shared/agent-launch/catalog/tui-agent'
import type { NativeChatForkRowAction } from './use-native-chat-fork'
import { useWorktreeRuntimeTarget } from '@/runtime/rpc/targets/use-worktree-runtime-target'
import { useStructuredAgentSessionHostCapabilityState } from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability'
import { AGENT_SESSION_CREATE_FORK_WORKTREE_RUNTIME_CAPABILITY } from '../../../../../../shared/agent-session/agent-session-create-capabilities'

/** Where a fork's new worktree branches from: the project's main branch, or the source's own branch. */
export type NativeChatWorktreeForkBase = 'main' | 'current'

/** The source worktree's branch when it can be forked into a sibling worktree; null otherwise. */
export function nativeChatWorktreeForkSourceBranch(sourceWorktreeId: string): string | null {
  const state = useAppStore.getState()
  const worktree = state.getKnownWorktreeById(sourceWorktreeId)
  const repo = worktree ? state.repos.find((entry) => entry.id === worktree.repoId) : undefined
  return forkableWorktreeBranch(worktree, repo, sourceWorktreeId)
}

/** Whether a menu should offer forking this worktree's chats: a git worktree whose host can fork into another. */
export function useNativeChatWorktreeForkOffered(worktreeId: string): boolean {
  const target = useWorktreeRuntimeTarget(worktreeId)
  const host = useStructuredAgentSessionHostCapabilityState(
    target,
    AGENT_SESSION_CREATE_FORK_WORKTREE_RUNTIME_CAPABILITY
  )
  return host === 'supported' && nativeChatWorktreeForkSourceBranch(worktreeId) !== null
}

/** Creates the fork's worktree, then opens the copied chat there; the source chat is never touched. */
export async function runNativeChatWorktreeFork(input: {
  sourceWorktreeId: string
  base: NativeChatWorktreeForkBase
  agent: TuiAgent
  throughItemId: string
  request: NativeChatForkRowAction['request']
}): Promise<boolean> {
  const state = useAppStore.getState()
  const worktree = state.getKnownWorktreeById(input.sourceWorktreeId)
  const branch = nativeChatWorktreeForkSourceBranch(input.sourceWorktreeId)
  if (!worktree || !branch) {
    toast.error(
      translate(
        'components.native-chat.fork.worktree.notGit',
        'This chat’s workspace is not a git worktree, so it can’t fork into a new one.'
      )
    )
    return false
  }
  let forkWorktreeId: string
  try {
    forkWorktreeId = (
      await createForkWorktree({
        sourceWorktreeId: input.sourceWorktreeId,
        repoId: worktree.repoId,
        sourceName: worktree.displayName || branch,
        sourceDisplayName: worktree.displayName,
        ...(input.base === 'current' ? { baseBranch: branch } : {}),
        agent: input.agent,
        source: 'chat_fork'
      })
    ).id
  } catch (error) {
    toast.error(
      translate(
        'components.native-chat.fork.worktree.createFailed',
        'Couldn’t create the worktree'
      ),
      { description: error instanceof Error ? error.message : undefined }
    )
    return false
  }
  activateAndRevealWorktree(forkWorktreeId, { sidebarRevealBehavior: 'auto' })
  const outcome = await input.request(input.throughItemId, undefined, {
    worktreeId: forkWorktreeId
  })
  // A launch failure is already reported; a fork that never started says so here.
  if (outcome === undefined) {
    toast.error(
      translate(
        'components.native-chat.fork.worktree.forkNotStarted',
        'The worktree was created, but the chat could not be forked into it.'
      )
    )
  }
  // The worktree exists now, so the dialog is done: retrying would create a second one.
  return true
}
