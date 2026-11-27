// The owner hands a workspace to a bot (Hand to bot…): what Orca tells the bot, and what its chat shows.
import * as z from 'zod'
import { lazyZodSchema } from '../schema/lazy-zod-schema'
import { TOOK_OVER_GOAL_HEADING, TOOK_OVER_TURN_PREFIX } from '../native-chat/took-over-notice'

export const BOT_TAKE_OVER_GOAL_MAX = 4_000

const Name = lazyZodSchema(() => z.string().trim().min(1).max(200))

export const BotTakeOverSchema = lazyZodSchema(() =>
  z.object({
    workspace: z.object({
      id: z.string().min(1),
      name: Name,
      project: Name.optional(),
      /** The paired computer it runs on, by the name the owner sees; absent on this computer. */
      computer: Name.optional(),
      /** Its environment id, for `--environment` on a paired computer. */
      environment: z.string().min(1).optional()
    }),
    /** Its agents, as the sidebar card names them ("Codex"); they keep running and work for the bot. */
    agents: z.array(Name).max(50),
    /** What the owner wants done with it, in their words; absent, the bot asks. */
    goal: z.string().trim().min(1).max(BOT_TAKE_OVER_GOAL_MAX).optional()
  })
)

export type BotTakeOver = z.infer<typeof BotTakeOverSchema>

/** The bot's one-line answer when no goal came with the workspace. */
export function botTakeOverAskLine(takeOver: Pick<BotTakeOver, 'workspace' | 'agents'>): string {
  const count = takeOver.agents.length
  const agents = count === 0 ? '' : ` (${count} ${count === 1 ? 'agent' : 'agents'})`
  return `I've taken over ${takeOver.workspace.name}${agents}. What should I do with it?`
}

/** Orca's turn to the bot: the hand-over as context, then what to do now. The chat draws it as a
 *  divider (and the goal as the owner's words), never as this text. */
export function botTakeOverKickoff(takeOver: BotTakeOver): string {
  const { workspace, agents, goal } = takeOver
  const where = [
    `id:${workspace.id}`,
    ...(workspace.project ? [`project ${workspace.project}`] : []),
    ...(workspace.environment
      ? [
          `on the paired computer${workspace.computer ? ` ${workspace.computer}` : ''} (environment ${workspace.environment})`
        ]
      : [])
  ].join(', ')
  const team =
    agents.length === 0
      ? 'It has no agents open.'
      : `Its agents keep running and now work for you: ${agents.join(', ')}. \`orca worktree ps --json\` gives each one's handle.`
  const lines = [
    `${TOOK_OVER_TURN_PREFIX}${workspace.name} (${where}). Orca already moved it under your home, so don't move it. ${team}]`
  ]
  if (!goal) {
    lines.push(
      `Your owner gave no goal for it yet. Run no commands and don't contact its agents. Reply with exactly this one line and nothing else, then wait: "${botTakeOverAskLine(takeOver)}"`
    )
    return lines.join('\n\n')
  }
  lines.push(
    agents.length === 0
      ? 'With no agent to ask, read its pull request and commits to see where things stand.'
      : 'Ask each of its agents where things stand, as step 2 of "Take over a workspace" in `orca skills get orca-cli --reference bots` says.',
    'Then tell your owner in a few lines where things stand, and start on what they asked.',
    `${TOOK_OVER_GOAL_HEADING}${goal}`
  )
  return lines.join('\n\n')
}
