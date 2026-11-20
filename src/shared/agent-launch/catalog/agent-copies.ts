import type { GlobalSettings } from '../../settings/global-settings-types'
import type { AgentCopy, TuiAgent } from './tui-agent'
import { isTuiAgent } from './tui-agent-config'

export type { AgentCopy }

/** The session option naming a launch's copy, so every route and every resume of it keeps it. */
export const AGENT_COPY_OPTION_ID = 'agentCopy'

const MAX_AGENT_COPIES = 64
const MAX_NAME_LENGTH = 80
const COPY_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/

export type AgentCopySettings = Partial<
  Pick<GlobalSettings, 'agentCopies' | 'agentCmdOverrides' | 'agentDefaultArgs' | 'agentDefaultEnv'>
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
  return {
    id,
    name,
    agent,
    ...(typeof command === 'string' && command.trim() ? { command: command.trim() } : {}),
    ...(typeof args === 'string' ? { args: args.trim() } : {}),
    ...(env ? { env } : {})
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

export function agentCopyIdFromOptions(
  options: Readonly<Record<string, unknown>> | null | undefined
): string | undefined {
  const value = options?.[AGENT_COPY_OPTION_ID]
  return isAgentCopyId(value) ? value : undefined
}

/** Launch options that start `copyId`; a built-in selection leaves the options as they are. */
export function withAgentCopyOption<V>(
  options: Readonly<Record<string, V>> | undefined,
  copyId: string | undefined
): Readonly<Record<string, V | string>> | undefined {
  return copyId ? { ...options, [AGENT_COPY_OPTION_ID]: copyId } : options
}

/** Settings as a copy's launch reads them: the copy's command, arguments and environment fill its
 *  base agent's slots, so every launch path below this point starts the copy unchanged. */
export function applyAgentCopy<T extends AgentCopySettings>(settings: T, copy: AgentCopy): T {
  return {
    ...settings,
    agentCmdOverrides: withSlot(settings.agentCmdOverrides, copy.agent, copy.command),
    agentDefaultArgs: withSlot(settings.agentDefaultArgs, copy.agent, copy.args),
    agentDefaultEnv: withSlot(settings.agentDefaultEnv, copy.agent, copy.env && { ...copy.env })
  }
}

function withSlot<V>(
  record: Partial<Record<TuiAgent, V>> | null | undefined,
  agent: TuiAgent,
  value: V | undefined
): Partial<Record<TuiAgent, V>> {
  const { [agent]: _base, ...rest } = record ?? {}
  return value === undefined ? rest : { ...rest, [agent]: value }
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

/** A new copy of `agent` named `name`, starting from the agent's current command, arguments and
 *  environment; its id is unique among `existing`. */
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
  const command = settings.agentCmdOverrides?.[agent]?.trim()
  const args = settings.agentDefaultArgs?.[agent]
  const env = settings.agentDefaultEnv?.[agent]
  return {
    id,
    name: name.trim().slice(0, MAX_NAME_LENGTH) || id,
    agent,
    ...(command ? { command } : {}),
    ...(args !== undefined ? { args: args.trim() } : {}),
    ...(env ? { env: { ...env } } : {})
  }
}
