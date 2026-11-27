// Whether an agent's workspace belongs to a bot: the bot's home folder, or a workspace nested under that home.
// The inbox draws such agents as the bot, and lists only what they need from you, never their finished turns:
// a bot works for others and on its own, so its "Done" is not news to you.
import type { AppState } from '@/store/types'
import { readRuntimeStatuses } from '@/store/slices/runtime-status/views/runtime-status-owner'
import { findBotByWorkspace } from '@/components/bots/bot-workspace'
import { botOfFolders, selectFolderAncestors } from '@/components/bots/use-worktree-bot'
import type { Bot } from '../../../../../shared/bot-types'
import type { Worktree } from '../../../../../shared/worktree/types'

type WorkspaceRef = Pick<Worktree, 'id' | 'hostId'>

/** The bot owning `workspace`, or null; reads the store and runtime statuses as they are now. */
export function botOfWorkspace(
  state: AppState,
  bots: readonly Bot[],
  workspace: WorkspaceRef
): Bot | null {
  if (bots.length === 0) {
    return null
  }
  return (
    findBotByWorkspace(bots, workspace.id) ??
    botOfFolders(selectFolderAncestors(state, readRuntimeStatuses(), workspace), bots)
  )
}

/** The same, from the workspace id an agent's row is owned by (all the rail dot's scan has). */
export function isBotWorkspaceId(
  state: AppState,
  bots: readonly Bot[],
  worktreeId: string
): boolean {
  if (bots.length === 0) {
    return false
  }
  if (findBotByWorkspace(bots, worktreeId) !== null) {
    return true
  }
  const worktree = state.getKnownWorktreeById(worktreeId)
  return worktree !== undefined && botOfWorkspace(state, bots, worktree) !== null
}
