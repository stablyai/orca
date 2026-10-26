import { z } from 'zod'
import { OptionalString, requiredString } from './rpc-param-primitives'

export const RoomMemberInput = z.object({
  memberId: requiredString('Missing member id'),
  name: requiredString('Missing member name'),
  isAdmin: z.boolean().optional()
})

export const RoomCreateParams = z.object({
  name: requiredString('Missing --name'),
  mode: z.enum(['admin', 'everyone']).optional(),
  notice: OptionalString,
  worktree: OptionalString,
  members: z.array(RoomMemberInput).optional()
})

export const RoomListParams = z.object({})

export const RoomShowParams = z.object({
  id: OptionalString,
  name: OptionalString
})

export const RoomDeleteParams = z.object({
  id: requiredString('Missing --id')
})

export const RoomMemberAddParams = z.object({
  id: requiredString('Missing --id'),
  memberId: requiredString('Missing --member-id'),
  name: requiredString('Missing --name'),
  isAdmin: z.boolean().optional()
})

export const RoomMemberRemoveParams = z.object({
  id: requiredString('Missing --id'),
  memberId: requiredString('Missing --member-id')
})

export const RoomMemberModelParams = z.object({
  id: requiredString('Missing --id'),
  memberId: requiredString('Missing --member-id'),
  model: requiredString('Missing --model')
})

export const RoomBotCreateParams = z.object({
  /** Room the bot joins. */
  id: requiredString('Missing --id'),
  /** Worktree selector (`id:<worktreeId>` or path) the bot's session lives under. */
  worktree: requiredString('Missing --worktree'),
  /** Structured agent lane (`claude`, `codex`, …). */
  agent: requiredString('Missing --agent'),
  /** Model override the new session launches under, e.g. `gpt-5.2-codex` or `opus`. */
  model: OptionalString,
  /** Thinking level for the model override; invalid values follow the model's own default. */
  effort: OptionalString,
  /** Display name in the room. */
  name: requiredString('Missing --name'),
  isAdmin: z.boolean().optional(),
  /** First-message instructions the new session receives, e.g. a role brief. */
  instructions: OptionalString
})

export const RoomSendParams = z.object({
  id: OptionalString,
  name: OptionalString,
  text: requiredString('Missing --text'),
  /** Explicit direct-room target; unlike an @mention it cannot be parsed ambiguously. */
  targetMemberId: OptionalString,
  from: OptionalString
})

export const RoomPostParams = z.object({
  id: requiredString('Missing --id'),
  memberId: requiredString('Missing --member-id'),
  text: requiredString('Missing --text')
})

export const RoomLogParams = z.object({
  id: requiredString('Missing --id'),
  memberId: OptionalString,
  limit: z.number().int().min(1).max(200).optional()
})

export const RoomEnsureMainBotParams = z.object({
  /** Worktree selector new bots spawn under when the room records none. */
  worktree: requiredString('Missing --worktree'),
  agent: OptionalString,
  /** Model override for the seeded admin bot. */
  model: OptionalString,
  /** Thinking level for the seeded admin bot's model. */
  effort: OptionalString,
  roomName: OptionalString,
  botName: OptionalString
})
