import type { GlobalSettings } from '../../settings/global-settings-types'
import type { AgentCopy, TuiAgent } from './tui-agent'
import { isTuiAgent } from './tui-agent-config'
import { normalizeAgentModelOptionChoices } from '../choices/agent-launch-choices'
import { isAgentPermissionChoice } from '../permissions/tui-agent-permission-choice'

export type { AgentCopy }

/** The session option naming a launch's copy, so every route and every resume of it keeps it. */
export const AGENT_COPY_OPTION_ID = 'agentCopy'

export const MAX_AGENT_COPIES = 64
const MAX_NAME_LENGTH = 80
const COPY_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/

export type AgentCopySettings = Partial<
  Pick<
    GlobalSettings,
    | 'agentCopies'
    | 'agentCmdOverrides'
    | 'agentDefaultArgs'
    | 'agentDefaultEnv'
    | 'agentLaunchChoices'
    | 'agentPermissionOverrides'
    | 'nativeChatProviders'
  >
>

/** The built-in agent a copy id names, or null for anything that is not a well-formed copy id. */
export function agentCopyBase(id: string): TuiAgent | null {
  const dot = id.indexOf('.')
  if (dot <= 0) {
    return null
  }
  const base = id.slice(0, dot)
  return isTuiAgent(base) && COPY_SLUG.test(id.slice(dot + 1)) ? base : null
}

export function isAgentCopyId(value: unknown): value is string {
  return typeof value === 'string' && agentCopyBase(value) !== null
}

function normalizeEnv(value: unknown): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const entries = Object.entries(value).flatMap(([name, raw]): [string, string][] =>
    name.trim() && typeof raw === 'string' ? [[name.trim(), raw]] : []
  )
  return Object.fromEntries(entries)
}

function normalizeAgentCopy(value: unknown): AgentCopy | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const entries = new Map<string, unknown>(Object.entries(value))
  const id = entries.get('id')
  const rawName = entries.get('name')
  const name = typeof rawName === 'string' ? rawName.trim().slice(0, MAX_NAME_LENGTH) : ''
  const agent = isAgentCopyId(id) ? agentCopyBase(id) : null
  if (!agent || !name || !isAgentCopyId(id)) {
    return null
  }
  const command = entries.get('command')
  const args = entries.get('args')
  const env = normalizeEnv(entries.get('env'))
  const choices = normalizeAgentModelOptionChoices(entries.get('choices'))
  const permission = entries.get('permission')
  const chat = entries.get('chat')
  return {
    id,
    name,
    agent,
    ...(typeof command === 'string' && command.trim() ? { command: command.trim() } : {}),
    ...(typeof args === 'string' ? { args: args.trim() } : {}),
    ...(env ? { env } : {}),
    ...(choices ? { choices } : {}),
    ...(isAgentPermissionChoice(permission) ? { permission } : {}),
    ...(typeof chat === 'boolean' ? { chat } : {}),
    ...(entries.get('disabled') === true ? { disabled: true as const } : {})
  }
}

/** Drops malformed entries and later duplicates of an id; the base agent always follows the id. */
export function normalizeAgentCopies(value: unknown): AgentCopy[] {
  if (!Array.isArray(value)) {
    return []
  }
  const seen = new Set<string>()
  const copies: AgentCopy[] = []
  for (const entry of value) {
    const copy = normalizeAgentCopy(entry)
    if (copy && !seen.has(copy.id) && copies.length < MAX_AGENT_COPIES) {
      seen.add(copy.id)
      copies.push(copy)
    }
  }
  return copies
}

export function findAgentCopy(
  settings: Pick<AgentCopySettings, 'agentCopies'> | null | undefined,
  id: string
): AgentCopy | undefined {
  return normalizeAgentCopies(settings?.agentCopies).find((copy) => copy.id === id)
}

export type AgentSelection = { agent: TuiAgent; copy?: AgentCopy }

/** Resolves an agent id a person typed or picked: a built-in id, or the id of a saved copy. */
export function resolveAgentSelection(
  id: string,
  settings: Pick<AgentCopySettings, 'agentCopies'> | null | undefined
): AgentSelection | null {
  if (isTuiAgent(id)) {
    return { agent: id }
  }
  const copy = findAgentCopy(settings, id)
  return copy ? { agent: copy.agent, copy } : null
}

/** The copy a launch's options name. A value that is not a copy id refuses, as a missing copy
 *  does, so it never falls back to the base agent; only an absent key means the agent itself. */
export function agentCopyIdFromOptions(
  options: Readonly<Record<string, unknown>> | null | undefined
): string | undefined {
  const value = options?.[AGENT_COPY_OPTION_ID]
  if (value === undefined) {
    return undefined
  }
  if (!isAgentCopyId(value)) {
    throw new Error(`Invalid agent copy id ${JSON.stringify(value)}`)
  }
  return value
}

/** The copy a launch names in either of its option maps; two different copies refuse, so neither
 *  is dropped for the other. */
export function agentCopyIdFromLaunchOptions(
  ...maps: (Readonly<Record<string, unknown>> | null | undefined)[]
): string | undefined {
  const ids = [...new Set(maps.map(agentCopyIdFromOptions).filter((id) => id !== undefined))]
  if (ids.length > 1) {
    throw new Error(`Conflicting agent copies "${ids[0]}" and "${ids[1]}"`)
  }
  return ids[0]
}

/** Launch options that start `copyId`; a built-in selection leaves the options as they are. */
export function withAgentCopyOption<V>(
  options: Readonly<Record<string, V>> | undefined,
  copyId: string | undefined
): Readonly<Record<string, V | string>> | undefined {
  return copyId ? { ...options, [AGENT_COPY_OPTION_ID]: copyId } : options
}

/** Launch options without the copy, for a create that carries the copy in its own field. */
export function withoutAgentCopyOption(
  options: Readonly<Record<string, string>> | undefined
): Readonly<Record<string, string>> | undefined {
  if (!options || !(AGENT_COPY_OPTION_ID in options)) {
    return options
  }
  const { [AGENT_COPY_OPTION_ID]: _copy, ...rest } = options
  return Object.keys(rest).length ? rest : undefined
}

/** Settings as a copy's launch reads them: the copy's own values fill its base agent's slots, so
 *  every launch path and every base-agent editor below this point works on the copy unchanged. */
export function applyAgentCopy<T extends AgentCopySettings>(settings: T, copy: AgentCopy): T {
  return {
    ...settings,
    agentCmdOverrides: withSlot(settings.agentCmdOverrides, copy.agent, copy.command),
    agentDefaultArgs: withSlot(settings.agentDefaultArgs, copy.agent, copy.args),
    agentDefaultEnv: withSlot(settings.agentDefaultEnv, copy.agent, copy.env && { ...copy.env }),
    // Absent choices mark a profile that predates them; a copy keeps that reading.
    ...(settings.agentLaunchChoices !== undefined || copy.choices
      ? {
          agentLaunchChoices: withSlot(settings.agentLaunchChoices, copy.agent, copy.choices)
        }
      : {}),
    agentPermissionOverrides: withSlot(
      settings.agentPermissionOverrides,
      copy.agent,
      copy.permission
    ),
    nativeChatProviders: withSlot(settings.nativeChatProviders, copy.agent, copy.chat)
  }
}

/** Settings as the launch of copy `id` reads them; no id, or a copy this host no longer has,
 *  leaves them as they are. */
export function applyAgentCopyById<T extends AgentCopySettings>(settings: T, id?: string): T {
  const copy = id ? findAgentCopy(settings, id) : undefined
  return copy ? applyAgentCopy(settings, copy) : settings
}

/** The copy as `settings` hold it in its base agent's slots, the inverse of `applyAgentCopy`: an
 *  edit made through the base agent's editors on the applied settings saves into the copy. */
export function captureAgentCopy(
  copy: Pick<AgentCopy, 'id' | 'name' | 'agent' | 'disabled'>,
  settings: AgentCopySettings
): AgentCopy {
  const { agent } = copy
  const command = settings.agentCmdOverrides?.[agent]?.trim()
  const args = settings.agentDefaultArgs?.[agent]
  const env = settings.agentDefaultEnv?.[agent]
  const choices = normalizeAgentModelOptionChoices(settings.agentLaunchChoices?.[agent])
  const permission = settings.agentPermissionOverrides?.[agent]
  const chat = settings.nativeChatProviders?.[agent]
  return {
    id: copy.id,
    name: copy.name,
    agent,
    ...(command ? { command } : {}),
    ...(args !== undefined ? { args: args.trim() } : {}),
    ...(env ? { env: { ...env } } : {}),
    ...(choices ? { choices } : {}),
    ...(permission ? { permission } : {}),
    ...(typeof chat === 'boolean' ? { chat } : {}),
    ...(copy.disabled ? { disabled: true as const } : {})
  }
}

function withSlot<V, K extends string>(
  record: Readonly<Partial<Record<K, V>>> | null | undefined,
  agent: K,
  value: V | undefined
): Partial<Record<K, V>> {
  const next: Partial<Record<K, V>> = { ...record }
  if (value === undefined) {
    delete next[agent]
  } else {
    next[agent] = value
  }
  return next
}

/** Applies the copy a launch's options name. A copy this host no longer has refuses, so a launch
 *  never silently becomes the base agent with someone else's settings. */
export function applyAgentCopyFromOptions<T extends AgentCopySettings>(
  agent: TuiAgent,
  settings: T,
  options: Readonly<Record<string, unknown>> | null | undefined
): T {
  const id = agentCopyIdFromOptions(options)
  if (!id) {
    return settings
  }
  const copy = findAgentCopy(settings, id)
  if (!copy || copy.agent !== agent) {
    throw new Error(`Unknown agent copy "${id}"`)
  }
  return applyAgentCopy(settings, copy)
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '')
  return slug || 'copy'
}

/** A new copy of `agent` named `name`, starting from the agent's current values; its id is unique
 *  among the saved copies. */
export function createAgentCopy(
  agent: TuiAgent,
  name: string,
  settings: AgentCopySettings
): AgentCopy {
  const taken = new Set(normalizeAgentCopies(settings.agentCopies).map((copy) => copy.id))
  const stem = `${agent}.${slugify(name)}`
  let id = stem
  for (let n = 2; taken.has(id); n++) {
    id = `${stem}-${n}`
  }
  return captureAgentCopy(
    { id, name: name.trim().slice(0, MAX_NAME_LENGTH) || id, agent },
    settings
  )
}
