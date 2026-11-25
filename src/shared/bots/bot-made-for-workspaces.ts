// A new bot its owner made for workspaces they already have: which ones, and Orca's first turn to it.
import * as z from 'zod'
import { BOT_CREATED_KICKOFF } from '../bot-created-kickoff'

/** A workspace the bot is made for: its id, since names repeat across projects and hosts. */
export const HandedWorkspaceSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(200)
})

export type HandedWorkspace = z.infer<typeof HandedWorkspaceSchema>

/** The most workspaces one new bot is made for. */
export const HANDED_WORKSPACES_MAX = 20

/** Orca's first turn: the greeting as usual; once the owner answers, it offers to take the workspaces over. */
export function botMadeForWorkspacesKickoff(workspaces: readonly HandedWorkspace[]): string {
  const list = workspaces.map((entry) => `${entry.name} (id:${entry.id})`).join(', ')
  return [
    `${BOT_CREATED_KICKOFF} Your owner made you for these workspaces: ${list}.`,
    'After your owner answers, offer to take them over. For each one they agree to, follow "Take over a workspace" in `orca skills get orca-cli --reference bots`.'
  ].join('\n\n')
}
