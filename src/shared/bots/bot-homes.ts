import type { Bot } from '../bot-types'
import type { FolderWorkspace } from '../folder-workspaces/folder-workspace-types'
import { getRepoExecutionHostId, type ExecutionHostId } from '../execution-host/execution-host'
import { getFolderWorkspaceChildWorktrees } from '../folder-workspace-child-worktrees'
import type { Worktree } from '../worktree/types'
import { getWorktreeHostIdentity } from '../worktree/host-qualified-identity'
import { getFolderWorkspaceHostIdentity } from '../folder-workspaces/folder-workspace-worktree'
import { folderWorkspaceKey } from '../workspace/identity/workspace-scope'
import { botHomeHostId } from './bot-home-host'

type BotHomeWorkspace = Pick<FolderWorkspace, 'id' | 'connectionId' | 'executionHostId'>
/** A paired server's bots name that server, not `local`, once the phone has read them. */
export type BotHomeOwner = Pick<Bot, 'folderWorkspaceId'> & {
  hostId: ExecutionHostId
  /** A phone reads these loosely, so their types are checked here. */
  sidebarOrder?: unknown
  createdAt?: unknown
}

/** The bot whose home `workspaceId` is: every chat there is that bot's, and is named by it. */
export function botOfHomeWorkspace<B extends Pick<Bot, 'folderWorkspaceId'>>(
  bots: readonly B[],
  workspaceId: string | null | undefined
): B | null {
  return workspaceId
    ? (bots.find((bot) => folderWorkspaceKey(bot.folderWorkspaceId) === workspaceId) ?? null)
    : null
}

/** A bot's or a group's home is listed as its owner, never as a workspace. */
export function isHome(workspace: BotHomeWorkspace, candidates: readonly BotHomeOwner[]): boolean {
  return candidates.some(
    (bot) =>
      bot.folderWorkspaceId === workspace.id &&
      getRepoExecutionHostId(workspace) === botHomeHostId(bot)
  )
}

/** New bots on top, newest first, as Manual sort stamps a new workspace; then the bots a drag placed, in that order. */
export function sortBotsBySidebarOrder<B extends Pick<BotHomeOwner, 'sidebarOrder' | 'createdAt'>>(
  bots: readonly B[]
): B[] {
  // A drop saves an order for every row, so a row without one is newer than the last drag.
  const placedOrder = (bot: B): number =>
    typeof bot.sidebarOrder === 'number' ? bot.sidebarOrder : Number.NEGATIVE_INFINITY
  const createdAt = (bot: B): number =>
    typeof bot.createdAt === 'number' ? bot.createdAt : Number.NEGATIVE_INFINITY
  const byKey = (left: number, right: number): number =>
    left === right ? 0 : left < right ? -1 : 1
  return bots
    .map((bot, index) => ({ bot, index }))
    .sort(
      (left, right) =>
        byKey(placedOrder(left.bot), placedOrder(right.bot)) ||
        byKey(createdAt(right.bot), createdAt(left.bot)) ||
        left.index - right.index
    )
    .map(({ bot }) => bot)
}

/** Each bot with its loaded home, in sidebar order; a bot whose home is not loaded yet has nothing to open. */
export function getBotHomes<B extends BotHomeOwner, W extends BotHomeWorkspace>(
  bots: readonly B[],
  folderWorkspaces: readonly W[]
): { bot: B; home: W }[] {
  return sortBotsBySidebarOrder(bots).flatMap((bot) => {
    const home = folderWorkspaces.find((workspace) => isHome(workspace, [bot]))
    return home ? [{ bot, home }] : []
  })
}

/** Host identities of the worktrees the Bots section lists: its workers' workspaces and their own children. */
export function getBotListedWorktreeIdentities(
  homes: readonly BotHomeWorkspace[],
  childrenByParentIdentity: ReadonlyMap<string, readonly Worktree[]>
): ReadonlySet<string> {
  const identities = new Set<string>()
  for (const home of homes) {
    const { childWorktrees, lineageChildrenByParentIdentity } = getFolderWorkspaceChildWorktrees(
      getFolderWorkspaceHostIdentity(home),
      childrenByParentIdentity
    )
    for (const worktree of [
      ...childWorktrees,
      ...[...lineageChildrenByParentIdentity.values()].flat()
    ]) {
      identities.add(getWorktreeHostIdentity(worktree))
    }
  }
  return identities
}
