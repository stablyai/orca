// Mirror of cloud/packages/connector-contract/src/linear-messages.ts for the desktop's reads.
import * as z from 'zod'
import { optionalConnectorAvatarUrl } from './connector-message-asker'

// GET `${linear}/state`: the Linear workspaces this Orca account is linked in, as which Linear user,
// and whether Orca's Linear app is installed there.
export const ConnectorLinearState = z.object({
  /** Opens Linear's install for a workspace admin; anyone may pass it on. */
  installUrl: z.string().url(),
  workspaces: z.array(
    z.object({
      workspaceId: z.string().min(1),
      name: z.string(),
      urlKey: z.string(),
      installed: z.boolean(),
      userId: z.string().min(1),
      userName: z.string(),
      /** The bot that takes this user's requests when a request names none; null when unset. */
      defaultBotId: z.string().nullable()
    })
  )
})
export type ConnectorLinearState = z.infer<typeof ConnectorLinearState>
export type ConnectorLinearWorkspace = ConnectorLinearState['workspaces'][number]

// GET `${linear}/workspaces/<id>/members?q=`: active people, a guest's name labelled so; complete as
// for Slack's.
export const ConnectorLinearMembersResponse = z.object({
  members: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      // Their Linear handle and picture; left out when they have none, or by an older cloud.
      handle: z.string().min(1).max(200).optional().catch(undefined),
      avatarUrl: optionalConnectorAvatarUrl
    })
  ),
  complete: z.boolean()
})
export type ConnectorLinearMembersResponse = z.infer<typeof ConnectorLinearMembersResponse>

/** The desktop's own code for a cloud with Linear off (every Linear route answers 404). */
export const BOT_LINEAR_OFF = 'linear_off'

/** A Linear issue key, e.g. ENG-123, as the cloud's comments route takes it. */
export const LINEAR_ISSUE_KEY_PATTERN = /^[A-Za-z0-9]{1,16}-[0-9]{1,9}$/
