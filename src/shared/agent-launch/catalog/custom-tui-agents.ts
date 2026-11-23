import type { TuiAgent } from './tui-agent'
import { isTuiAgent } from './tui-agent-config'

/** A named launch entry backed by an installed agent: its command (such as a wrapper that execs the
 *  agent) replaces the agent's Settings command, while the agent's status, prompts and resume stay. */
export type CustomTuiAgent = {
  id: string
  name: string
  agent: TuiAgent
  command: string
}

export type CustomTuiAgentSettings = {
  /** Named launch entries backed by an installed agent, each with its own command (e.g. a wrapper). */
  customTuiAgents?: CustomTuiAgent[]
}

export const MAX_CUSTOM_TUI_AGENTS = 50
const MAX_ID_LENGTH = 80
const MAX_NAME_LENGTH = 80
const MAX_COMMAND_LENGTH = 4000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readText(value: unknown, maxLength: number): string {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : ''
}

/** Drops incomplete or duplicate entries; a command stays one shell line. */
export function normalizeCustomTuiAgents(input: unknown): CustomTuiAgent[] {
  if (!Array.isArray(input)) {
    return []
  }
  const seen = new Set<string>()
  const normalized: CustomTuiAgent[] = []
  for (const item of input) {
    if (normalized.length >= MAX_CUSTOM_TUI_AGENTS) {
      break
    }
    if (!isRecord(item)) {
      continue
    }
    const id = readText(item.id, MAX_ID_LENGTH)
    const name = readText(item.name, MAX_NAME_LENGTH)
    // A line break would run the rest as a separate shell command.
    const command =
      typeof item.command === 'string'
        ? readText(item.command.replace(/\s*[\r\n]+\s*/g, ' '), MAX_COMMAND_LENGTH)
        : ''
    if (!id || seen.has(id) || !name || !command || !isTuiAgent(item.agent)) {
      continue
    }
    seen.add(id)
    normalized.push({ id, name, agent: item.agent, command })
  }
  return normalized
}
