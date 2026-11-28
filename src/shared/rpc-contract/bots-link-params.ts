import * as z from 'zod'
import { lazyZodSchema } from '../schema/lazy-zod-schema'
import { OptionalString, requiredString } from './rpc-param-primitives'

/** `orca bot link`: a link that opens one of this computer's workspaces wherever it is clicked. */
export const BotLink = lazyZodSchema(() =>
  z.object({
    worktree: requiredString('Name the workspace with --worktree.'),
    /** The orca session id of an agent in it, whose chat the link also opens. */
    agentSessionId: OptionalString,
    botId: OptionalString,
    callerSessionId: OptionalString
  })
)

export type BotLinkParams = z.infer<typeof BotLink>

export type BotLinkResult = {
  link: string
  workspaceName: string
  botName: string
}
