import type { GlobalSettings } from './global-settings-types'
import type { TuiAgent } from './tui-agent'
import { parseAgentCommand } from './agent-command-plan'

/** Literal program and prefix; chat never evaluates shell syntax. */
export function structuredAgentCommandPlan(command: string, platform?: NodeJS.Platform) {
  const input = command.trim()
  if (!input || /[\0\r\n$`]/.test(input)) {
    return null
  }
  const windowsPath = /^(?:["']?)(?:[A-Za-z]:[\\/]|\\\\)/.test(input)
  const parsed = parseAgentCommand(
    '',
    input,
    platform === 'win32' || windowsPath ? 'literal' : 'escape'
  )
  if (
    !parsed.ok ||
    parsed.env ||
    parsed.divergesFromShell ||
    [parsed.binary, ...parsed.prefixArgs].some((token) => /[|&;<>(){}[\]*?!]/.test(token))
  ) {
    return null
  }
  return { program: parsed.binary, prefixArgs: parsed.prefixArgs }
}

/** Terminal-backed chat skips the structured catalog when its launch command is customized. */
export function hasExplicitTuiLaunchCommand(
  settings: Partial<Pick<GlobalSettings, 'agentCmdOverrides'>> | null | undefined,
  agent: TuiAgent
): boolean {
  return Boolean(settings?.agentCmdOverrides?.[agent]?.trim())
}
