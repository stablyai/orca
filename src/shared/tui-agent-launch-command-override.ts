import type { GlobalSettings } from './global-settings-types'
import type { TuiAgent } from './tui-agent'
import { tokenizeCustomCommandTemplate } from './commit-message-prompt'

/** A single literal executable; the execution host verifies that the file is runnable. */
export function structuredAgentCommandToken(command: string): string | null {
  const input = command.trim()
  if (!input || /[\0\r\n$`]/.test(input)) {
    return null
  }
  const windowsPath = /^(?:["']?)(?:[A-Za-z]:[\\/]|\\\\)/.test(input)
  const parsed = tokenizeCustomCommandTemplate(input, windowsPath ? 'literal' : 'escape')
  if (
    !parsed.ok ||
    parsed.tokens.length !== 1 ||
    parsed.spans.some((span) => span.divergesFromShell)
  ) {
    return null
  }
  const token = parsed.tokens[0]
  return token && !/[|&;<>(){}[\]*?!]/.test(token) ? token : null
}

/** Terminal-backed chat skips the structured catalog when its launch command is customized. */
export function hasExplicitTuiLaunchCommand(
  settings: Partial<Pick<GlobalSettings, 'agentCmdOverrides'>> | null | undefined,
  agent: TuiAgent
): boolean {
  return Boolean(settings?.agentCmdOverrides?.[agent]?.trim())
}
