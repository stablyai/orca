import type { TerminalQuickCommand } from './terminal-quick-command-types'
import { getTerminalQuickCommandBody, isTerminalAgentQuickCommand } from './terminal-quick-commands'

export type TerminalQuickCommandArgument = {
  name: string
  /** Present for `{{name:a,*b}}`; the run prompt renders a select instead of a text field. */
  options?: string[]
  defaultValue: string
  required: boolean
}

// Why: `{{name}}` avoids colliding with shell `${VAR}` syntax; leading `.` (Go templates) never matches.
const ARGUMENT_TOKEN_RE = /\{\{\s*([A-Za-z_][\w-]{0,39})\s*(\?)?\s*(?:([:=])([^{}]*))?\}\}/g

function parseArgumentToken(
  name: string,
  optional: boolean,
  kind: string | undefined,
  spec: string | undefined
): TerminalQuickCommandArgument {
  if (kind === ':') {
    const rawOptions = (spec ?? '')
      .split(',')
      .map((option) => option.trim())
      .filter((option) => option.length > 0)
    const starred = rawOptions.find((option) => option.startsWith('*'))
    const options = [
      ...new Set(rawOptions.map((option) => (option.startsWith('*') ? option.slice(1) : option)))
    ].filter((option) => option.length > 0)
    if (options.length > 0) {
      return {
        name,
        options,
        defaultValue: starred ? starred.slice(1) : options[0],
        required: true
      }
    }
  }
  return {
    name,
    defaultValue: kind === '=' ? (spec ?? '').trim() : '',
    required: !optional
  }
}

/** The first token that names an argument defines it; later `{{name}}` tokens reuse its value. */
export function parseTerminalQuickCommandArguments(text: string): TerminalQuickCommandArgument[] {
  const byName = new Map<string, TerminalQuickCommandArgument>()
  for (const match of text.matchAll(ARGUMENT_TOKEN_RE)) {
    const [, name, optional, kind, spec] = match
    const existing = byName.get(name)
    if (!existing || (existing.defaultValue === '' && !existing.options && kind)) {
      byName.set(name, parseArgumentToken(name, optional === '?', kind, spec))
    }
  }
  return [...byName.values()]
}

export function getTerminalQuickCommandArguments(
  command: TerminalQuickCommand
): TerminalQuickCommandArgument[] {
  return parseTerminalQuickCommandArguments(getTerminalQuickCommandBody(command))
}

export function applyTerminalQuickCommandArguments(
  text: string,
  values: Readonly<Record<string, string>>
): string {
  // Why: a line break in a value would submit a partial command line in the terminal.
  return text.replace(ARGUMENT_TOKEN_RE, (token, name: string) =>
    Object.hasOwn(values, name) ? values[name].replace(/[\r\n]+/g, ' ') : token
  )
}

export function fillTerminalQuickCommandArguments(
  command: TerminalQuickCommand,
  values: Readonly<Record<string, string>>
): TerminalQuickCommand {
  return isTerminalAgentQuickCommand(command)
    ? { ...command, prompt: applyTerminalQuickCommandArguments(command.prompt, values) }
    : { ...command, command: applyTerminalQuickCommandArguments(command.command, values) }
}
