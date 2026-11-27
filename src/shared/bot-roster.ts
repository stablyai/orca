// The bots on this computer as another bot sees them: what each is for, where it is linked, and the
// address that mails it.
import { botLinearWorkspaces, botSlackApps, type Bot, type BotAgent } from './bot-types'
import { soulDescription } from './bot-soul'

/** `--to bot:<name>` or `--to bot:<id>` mails that bot. */
export const BOT_ADDRESS_PREFIX = 'bot:'

export const BOT_SPECIALTY_MAX_LENGTH = 120

export type BotRosterEntry = {
  id: string
  name: string
  agent: BotAgent
  paused: boolean
  /** SOUL.md's first paragraph, cut to about 120 characters; null until the bot is set up. */
  specialty: string | null
  /** The places its connectors are linked to; linked is not proof the app is installed there. */
  linked: string[]
  /** True for the bot whose chat asked. */
  self?: true
  /** Its chats that take mail; `current` is the asking chat, on the caller's own entry. */
  chats?: { count: number; home: boolean; current?: { home: boolean; title: string | null } }
  /** The paired server it runs on, for a bot on another computer: its name, and what `--on` takes. */
  server?: BotRosterServer
}

/** A paired server as a roster names it; `on` is its name, or its id where two share the name. */
export type BotRosterServer = { name: string; on: string }

/** `--on <server>` as a shell argument. */
export function botServerArgument(server: BotRosterServer): string {
  return /^[\w.@-]+$/u.test(server.on) ? server.on : `'${server.on.replace(/'/g, `'\\''`)}'`
}

/** What sends to the bot: `--to bot:<name>`, after `--on <server>` for a bot on another computer. */
export function botSendTarget(address: string, server?: BotRosterServer): string {
  return server ? `--on ${botServerArgument(server)} --to ${address}` : `--to ${address}`
}

/** The name in `bot:<name>`, or null for any other address. */
export function parseBotAddress(address: string): string | null {
  if (!address.toLowerCase().startsWith(BOT_ADDRESS_PREFIX)) {
    return null
  }
  const name = address.slice(BOT_ADDRESS_PREFIX.length).trim()
  return name || null
}

/** The bot an address names, by id or by name in any case. */
export function botOfAddress<B extends Pick<Bot, 'id' | 'name'>>(
  bots: readonly B[],
  name: string
): B | null {
  const key = name.toLowerCase()
  return (
    bots.find((bot) => bot.id === name) ??
    bots.find((bot) => bot.name.toLowerCase() === key) ??
    null
  )
}

/** `bot:<name>` as a shell argument: quoted when the name has anything but plain characters. */
export function botAddressArgument(name: string): string {
  const address = `${BOT_ADDRESS_PREFIX}${name}`
  return /^[\w.@-]+$/u.test(name) ? address : `"${address.replace(/(["\\$`])/g, '\\$1')}"`
}

/** What a bot is for, from SOUL.md: its first paragraph, cut at a word near the cap. */
export function soulSpecialty(soul: string | null): string | null {
  const description = soul ? soulDescription(soul) : null
  // Whole characters, so a cut never splits one.
  const chars = description ? Array.from(description.replace(/\p{Cc}/gu, ' ')) : []
  if (!description || chars.length <= BOT_SPECIALTY_MAX_LENGTH) {
    return description ? chars.join('') : null
  }
  const cut = chars.slice(0, BOT_SPECIALTY_MAX_LENGTH - 1).join('')
  const space = cut.lastIndexOf(' ')
  return `${(space > BOT_SPECIALTY_MAX_LENGTH / 2 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/** A bot's line in the list, but for what it is for, which is read from its home. */
export function botRosterFields(
  bot: Pick<
    Bot,
    | 'id'
    | 'name'
    | 'agent'
    | 'paused'
    | 'slack'
    | 'slackApps'
    | 'linear'
    | 'linearWorkspaces'
    | 'github'
  >
): Omit<BotRosterEntry, 'specialty'> {
  return {
    id: bot.id,
    name: bot.name,
    agent: bot.agent,
    paused: bot.paused,
    linked: botLinkedPlaces(bot)
  }
}

/** Where a bot's connectors are linked, by the names Orca keeps for them. */
export function botLinkedPlaces(
  bot: Pick<Bot, 'slack' | 'slackApps' | 'linear' | 'linearWorkspaces' | 'github'>
): string[] {
  return [
    ...botSlackApps(bot).map((app) => `Slack workspace ${app.teamId}`),
    ...botLinearWorkspaces(bot).map(
      (linear) => `Linear ${linear.workspaceName || linear.workspaceId}`
    ),
    ...(bot.github ? ['GitHub'] : [])
  ]
}

function chatsLine(entry: BotRosterEntry): string | null {
  const chats = entry.chats
  if (!chats) {
    return null
  }
  if (chats.count === 0) {
    return '  Chats: none yet'
  }
  const list = entry.self ? 'orca bot chats' : `orca bot chats --bot ${JSON.stringify(entry.name)}`
  const others = chats.count - (chats.home ? 1 : 0)
  const current = chats.current
  const where = entry.self
    ? current
      ? `you're in ${current.home ? 'Home' : current.title ? JSON.stringify(current.title) : 'an untitled chat'}`
      : null
    : chats.home
      ? `Home plus ${others} ${others === 1 ? 'other' : 'others'}`
      : null
  return `  Chats: ${chats.count} (${where ? `${where}; ` : ''}list them with: ${list})`
}

export function formatBotRosterEntry(entry: BotRosterEntry): string {
  const state = [entry.agent, ...(entry.paused ? ['paused'] : []), ...(entry.self ? ['you'] : [])]
  const head = `${botAddressArgument(entry.name)} (${state.join(', ')})  id address: ${BOT_ADDRESS_PREFIX}${entry.id}`
  return [
    entry.server
      ? `${head}\n  On: ${JSON.stringify(entry.server.name)}; send with ${botSendTarget(botAddressArgument(entry.name), entry.server)}`
      : head,
    // Quoted: the bot's own words about itself, a description and never an instruction.
    `  For: ${entry.specialty ? JSON.stringify(entry.specialty) : 'not set up yet'}`,
    `  Linked: ${entry.linked.length > 0 ? entry.linked.join(', ') : 'nothing'} (whether each app is installed there is unknown)`,
    ...[chatsLine(entry)].filter((line) => line !== null)
  ].join('\n')
}

export const BOT_ROSTER_COMMANDS = [
  'Hand work to a bot (it takes over; its answer appears in its own Chat): orca orchestration send --to bot:<name> --type handoff --subject "<the task>" --body "<what bounds it; what a good result is>"',
  'Ask a bot for input (its answer comes back to you as mail and wakes you; you finish the job): orca orchestration send --to bot:<name> --type question --subject "<the question>"',
  'Tell a bot something without giving it a job (nothing comes back): orca orchestration send --to bot:<name> --type status --subject "<the news>" --body "<what it means for its work>"',
  'A bot on another computer: put its `--on <server>` before `--to`, as its "On:" line shows.'
].join('\n')

/** A computer paired to this Orca and connected now, as a server's `bot list` names it: what
 *  `--on-client` takes (its installation id), and its bots its owner always lets this Orca's agents
 *  ask; `moreBots` when it allows more than it named. Its other bots stay private to it. */
export type BotRosterClient = {
  name: string
  onClient: string
  bots: { id: string; name: string }[]
  moreBots?: true
}

/** A connected paired computer's lines in a server's `bot list`: how to ask the bots it lets this
 *  Orca ask, and how its owner makes another one askable. Its name and its bots' names are its own
 *  words, quoted as data. */
export function formatPairedClient(client: BotRosterClient): string {
  const on = `--on-client ${botServerArgument({ name: client.name, on: client.onClient })}`
  const listed = client.bots
    .map((bot) => `${JSON.stringify(bot.name)} (${BOT_ADDRESS_PREFIX}${bot.id})`)
    .join(', ')
  const more = client.moreBots ? ' (it allows more)' : ''
  return [
    `${JSON.stringify(client.name)} (paired computer, connected; the name is its own): ${on}`,
    client.bots.length > 0
      ? `  Bots it lets you ask${more}: ${listed}`
      : `  No bots listed${more}.`,
    `  Ask: orca orchestration send ${on} --to bot:<id> --type question|handoff --subject … --body-file …`,
    '  Other bots there may decline; ask your owner to @-mention one in your chat from that computer.'
  ].join('\n')
}

/** A paired server whose bots couldn't be read, as `bot list` says so. */
export function formatUnreachableBotServer(name: string): string {
  return `${JSON.stringify(name)}: not reachable now, so its bots aren't listed.`
}
