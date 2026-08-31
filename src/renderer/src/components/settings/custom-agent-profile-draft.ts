import type { AgentCatalogEntry } from '@/lib/agent-catalog'
import {
  createCustomAgentProfileId,
  type CustomAgentProfile
} from '../../../../shared/custom-agent-profile'
import { tokenizeStartupCommand } from '../../../../shared/tui-agent-startup-shell'
import type { AgentStartupShell } from '../../../../shared/tui-agent-startup-shell'

export type CustomAgentProfileDraft = CustomAgentProfile

function uniqueCopyName(name: string, reservedNames: readonly string[]): string {
  const names = new Set(reservedNames.map((value) => value.trim().toLowerCase()))
  for (let suffix = 1; suffix <= reservedNames.length + 1; suffix += 1) {
    const candidate = suffix === 1 ? `${name} copy` : `${name} copy ${suffix}`
    if (!names.has(candidate.toLowerCase())) {
      return candidate
    }
  }
  return `${name} copy ${Date.now().toString(36)}`
}

function literalTokens(value: string, shell: AgentStartupShell): string[] | null {
  if (!value.trim()) {
    return []
  }
  const parsed = tokenizeStartupCommand(value, shell)
  return parsed.ok && parsed.spans.every((span) => !span.divergesFromShell) ? parsed.tokens : null
}

export function createCustomAgentProfileDraft(): CustomAgentProfileDraft {
  return {
    id: createCustomAgentProfileId(),
    name: '',
    executable: '',
    args: []
  }
}

export function duplicateBuiltInAgentAsCustom(args: {
  agent: AgentCatalogEntry
  command: string
  launchArgs: string
  shell: AgentStartupShell
  reservedNames: readonly string[]
}): CustomAgentProfileDraft | null {
  const commandTokens = literalTokens(args.command, args.shell)
  const launchArgTokens = literalTokens(args.launchArgs, args.shell)
  if (!commandTokens?.length || !launchArgTokens) {
    return null
  }
  return {
    id: createCustomAgentProfileId(),
    name: uniqueCopyName(args.agent.label, args.reservedNames),
    baseAgent: args.agent.id,
    executable: commandTokens[0],
    args: [...commandTokens.slice(1), ...launchArgTokens]
  }
}
