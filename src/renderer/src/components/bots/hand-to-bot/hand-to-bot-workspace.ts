// What Hand to bot reads from the workspace (a bot name, a purpose, an agent) and how it moves it under
// the bot's home: the same Set Parent write a sidebar drop makes.
import { useAppStore } from '@/store'
import { readRuntimeStatuses } from '@/store/slices/runtime-status/views/runtime-status-owner'
import { getDropFolderParentsInState } from '@/components/sidebar/workspace-actions/parenting/use-eligible-folder-parents'
import { isCrossStoreParent } from '@/store/slices/worktrees/metadata/cross-store-parent-ref'
import { getFolderWorkspaceWorktree } from '../../../../../shared/folder-workspaces/folder-workspace-worktree'
import { isHome } from '../../../../../shared/bots/bot-homes'
import { getWorktreeHostIdentity } from '../../../../../shared/worktree/host-qualified-identity'
import {
  BOT_NAME_MAX_LENGTH,
  isBotAgent,
  type Bot,
  type BotAgent
} from '../../../../../shared/bot-types'
import type { Worktree } from '../../../../../shared/worktree/types'
import { LINEAGE_PARENT_CHANGED } from '../../../../../shared/worktree/lineage-parent-changed'
import { selectSidebarLineageParentIdentities } from '@/store/slices/worktrees/metadata/cross-store-lineage-parents'
import { getIndexedAllWorktrees } from '@/store/slices/worktrees/listing/worktree-catalog-index'
import {
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'

// A branch's kind of change, which says nothing about what the bot is for.
const BRANCH_KIND = /^(fix|feat|feature|chore|refactor|docs|test|perf|build|ci|wip|hotfix|bugfix)$/i

function words(name: string): string[] {
  const last = name.split('/').findLast(Boolean) ?? name
  return last.split(/[-_\s.]+/).filter(Boolean)
}

/** "fix-relay-reconnect" → "Relay Reconnect". */
export function suggestedBotName(workspaceName: string): string {
  const all = words(workspaceName)
  const kept = all.length > 1 && BRANCH_KIND.test(all[0]!) ? all.slice(1) : all
  const name = kept.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
  return name.slice(0, BOT_NAME_MAX_LENGTH)
}

/** Its task's first line (the workspace's note), else its branch in words. */
export function suggestedBotPurpose(worktree: Pick<Worktree, 'comment' | 'branch'>): string {
  const note = worktree.comment
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean)
  if (note) {
    return note.slice(0, 200)
  }
  const branch = words(worktree.branch.replace(/^refs\/heads\//, '')).join(' ')
  return branch ? branch.charAt(0).toUpperCase() + branch.slice(1) : ''
}

/** The workspace's agent when a bot can run on it, else Claude. */
export function suggestedBotAgent(agentTypes: readonly string[]): BotAgent {
  return agentTypes.find(isBotAgent) ?? 'claude'
}

/** The bot's home as a Set Parent target for `child`; null when it isn't loaded or that store can't
 *  take a folder parent. */
export function botHomeParentFor(child: Worktree, bot: Bot): Worktree | null {
  const state = useAppStore.getState()
  const home = (selectFolderWorkspaces(state) ?? []).find((folder) => isHome(folder, [bot]))
  if (!home) {
    return null
  }
  const identity = getWorktreeHostIdentity(getFolderWorkspaceWorktree(home))
  return (
    getDropFolderParentsInState(state, readRuntimeStatuses(), child).find(
      (folder) => getWorktreeHostIdentity(folder) === identity
    ) ?? null
  )
}

/** Moves `child` under `parent`, as Set Parent does: a cross-machine ref for a paired computer's
 *  workspace. With `ifParentWorkspace`, the owning store writes only while that is still its parent. */
export async function moveUnderParent(
  child: Worktree,
  parent: Worktree,
  ifParentWorkspace?: string
): Promise<void> {
  const state = useAppStore.getState()
  const condition = ifParentWorkspace !== undefined ? { ifParentWorkspace } : {}
  if (isCrossStoreParent(child, parent)) {
    await state.assignCrossStoreWorktreeParent([child], parent, condition)
    return
  }
  await state.assignWorktreeParent(child.id, {
    parentWorktreeId: parent.id,
    ...(child.hostId ? { executionHostId: child.hostId } : {}),
    ...condition
  })
}

/** Where the workspace sits now, so a hand-over the bot refused can put it back. */
export function placementOf(child: Worktree): Worktree | null {
  const state = useAppStore.getState()
  const parent = selectSidebarLineageParentIdentities(state, readRuntimeStatuses())?.get(
    getWorktreeHostIdentity(child)
  )
  if (parent === undefined) {
    return null
  }
  const rows = [
    ...getIndexedAllWorktrees(selectWorktreesByRepo(state)),
    ...(selectFolderWorkspaces(state) ?? []).map((folder) => getFolderWorkspaceWorktree(folder))
  ]
  return rows.find((row) => getWorktreeHostIdentity(row) === parent) ?? null
}

/** Back under `parent` (as Set Parent puts it), or out of any parent when it had none, but only while
 *  it is still under `handedTo`: the owning store compares and writes in one step, so a move the owner
 *  made meanwhile stands. */
export async function restorePlacement(
  child: Worktree,
  parent: Worktree | null,
  handedTo: string
): Promise<void> {
  if (parent) {
    await moveUnderParent(child, parent, handedTo)
    return
  }
  await useAppStore.getState().updateWorktreeLineage(child.id, {
    noParent: true,
    ifParentWorkspace: handedTo,
    ...(child.hostId ? { executionHostId: child.hostId } : {})
  })
}

/** The owning store refused a conditional move back: the owner moved the workspace since. */
export function movedSince(error: unknown): boolean {
  return error instanceof Error && error.message.includes(LINEAGE_PARENT_CHANGED)
}

export type HandOverOutcome =
  | { ok: true; sessionId: string }
  /** `stage` failed. After a refused notice, `placement` says where the workspace is: put back,
   *  left where the owner moved it since, or left under the bot because putting it back failed. */
  | {
      ok: false
      stage: 'move' | 'notify'
      error: unknown
      placement?: 'restored' | 'moved-since' | 'left'
    }

/** Moves the workspace, then tells the bot. A bot that can't take it leaves no half-done hand-over:
 *  the workspace goes back where it was, and the owner can try again. */
export async function handOverWorkspace(steps: {
  move: () => Promise<void>
  notify: () => Promise<string>
  restore: () => Promise<void>
}): Promise<HandOverOutcome> {
  try {
    await steps.move()
  } catch (error) {
    return { ok: false, stage: 'move', error }
  }
  try {
    return { ok: true, sessionId: await steps.notify() }
  } catch (error) {
    const placement = await steps.restore().then(
      () => 'restored' as const,
      (restoreError: unknown) => (movedSince(restoreError) ? 'moved-since' : 'left')
    )
    return { ok: false, stage: 'notify', error, placement }
  }
}
