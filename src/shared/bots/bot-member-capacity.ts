// How many people a bot takes: BOT_MAX_MEMBERS in all, and the cloud's limit per Linear workspace or
// GitHub installation (a hello carries no more, so anyone past it could never ask). An add that would
// pass either is refused whole, naming who and why, so access is never granted in part or in silence.
import * as z from 'zod'
import {
  BOT_MAX_MEMBERS,
  botMemberSource,
  gitHubMembersOf,
  linearMembersOf,
  type BotMember
} from '../bot-types'
import { CONNECTOR_CLIENT_LIMITS } from '../connectors/connector-cloud-contract'

const BotMembersFullSchema = z.object({
  /** `bot`: the bot's own limit; `workspace`: one Linear workspace's or GitHub installation's. */
  scope: z.enum(['bot', 'workspace']),
  limit: z.number(),
  /** Who could not be added, by name. */
  names: z.array(z.string())
})

export type BotMembersFull = z.infer<typeof BotMembersFullSchema>

/** The people a connector's workspace counts against its limit; null for a service without one. */
function workspaceMembers(members: readonly BotMember[], member: BotMember): BotMember[] | null {
  const source = botMemberSource(member)
  if (member.workspaceId === undefined) {
    return null
  }
  if (source === 'linear') {
    return linearMembersOf(members, member.workspaceId)
  }
  if (source === 'github') {
    return gitHubMembersOf(members, member.workspaceId)
  }
  return null
}

const sameMember = (a: BotMember, b: BotMember): boolean =>
  a.id === b.id && botMemberSource(a) === botMemberSource(b) && a.workspaceId === b.workspaceId

/** Those people added after the rest, each once; or why they can't all be. */
export function planBotMemberAdds(
  members: readonly BotMember[],
  added: readonly BotMember[]
): { ok: true; members: BotMember[] } | { ok: false; full: BotMembersFull } {
  const next = [...members]
  const refused: { member: BotMember; scope: BotMembersFull['scope'] }[] = []
  for (const member of added) {
    if (next.some((entry) => sameMember(entry, member))) {
      continue
    }
    const workspace = workspaceMembers(next, member)
    if (next.length >= BOT_MAX_MEMBERS) {
      refused.push({ member, scope: 'bot' })
    } else if (workspace && workspace.length >= CONNECTOR_CLIENT_LIMITS.maxBotWorkspaceMembers) {
      refused.push({ member, scope: 'workspace' })
    } else {
      next.push(member)
    }
  }
  if (refused.length === 0) {
    return { ok: true, members: next }
  }
  const scope = refused.some((entry) => entry.scope === 'bot') ? 'bot' : 'workspace'
  return {
    ok: false,
    full: {
      scope,
      limit: scope === 'bot' ? BOT_MAX_MEMBERS : CONNECTOR_CLIENT_LIMITS.maxBotWorkspaceMembers,
      names: refused.map(({ member }) => member.name || member.id)
    }
  }
}

const FULL_PREFIX = 'bot_members_full:'

/** The error a refused add fails with; its message survives the RPC, so the owner's window can say who. */
export function botMembersFullError(full: BotMembersFull): Error {
  return new Error(`${FULL_PREFIX}${JSON.stringify(full)}`)
}

export function readBotMembersFull(error: unknown): BotMembersFull | null {
  if (!(error instanceof Error) || !error.message.startsWith(FULL_PREFIX)) {
    return null
  }
  try {
    const full = BotMembersFullSchema.safeParse(JSON.parse(error.message.slice(FULL_PREFIX.length)))
    return full.success ? full.data : null
  } catch {
    return null
  }
}
