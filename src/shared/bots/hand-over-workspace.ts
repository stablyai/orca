// Hand to bot…, on the desktop and the phone alike: what a new bot for a workspace is called, and the
// move-then-tell sequence that leaves no half-done hand-over.
import { BOT_NAME_MAX_LENGTH, isBotAgent, type BotAgent } from '../bot-types'
import { LINEAGE_PARENT_CHANGED } from '../worktree/lineage-parent-changed'

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
export function suggestedBotPurpose(worktree: { comment?: string; branch: string }): string {
  const note = (worktree.comment ?? '')
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean)
  if (note) {
    return note.slice(0, 200)
  }
  const branch = words(worktree.branch.replace(/^refs\/heads\//, '')).join(' ')
  return branch ? (branch.charAt(0).toUpperCase() + branch.slice(1)).slice(0, 200) : ''
}

/** The workspace's agent when a bot can run on it, else Claude. */
export function suggestedBotAgent(agentTypes: readonly string[]): BotAgent {
  return agentTypes.find(isBotAgent) ?? 'claude'
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
