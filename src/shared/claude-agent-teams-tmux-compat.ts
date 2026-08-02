export type ClaudeAgentTeamsMode = 'off' | 'in-process' | 'native-panes-shim'

export type ParsedTmuxCommand = {
  command: string
  args: string[]
}

export type ParsedTmuxArgs = {
  flags: Set<string>
  values: Map<string, string[]>
  positional: string[]
}

const TMUX_FORMAT_VAR_RE = /#\{[^}]+\}/g

export function splitTmuxCommand(argv: string[]): ParsedTmuxCommand {
  const globalValueFlags = new Set(['-L', '-S', '-f'])
  const globalBoolFlags = new Set(['-V', '-v'])

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? ''
    if (arg === '--') {
      break
    }
    if (!arg.startsWith('-') || arg === '-') {
      return { command: arg.toLowerCase(), args: argv.slice(i + 1) }
    }
    if (globalBoolFlags.has(arg)) {
      return { command: arg, args: [] }
    }
    if (globalValueFlags.has(arg)) {
      i += 1
    }
  }

  throw new Error('tmux shim requires a command')
}

export function parseTmuxArgs(
  args: string[],
  valueFlags: string[],
  boolFlags: string[]
): ParsedTmuxArgs {
  const valueSet = new Set(valueFlags)
  const boolSet = new Set(boolFlags)
  const flags = new Set<string>()
  const values = new Map<string, string[]>()
  const positional: string[] = []
  let pastTerminator = false

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i] ?? ''
    if (pastTerminator) {
      positional.push(arg)
      continue
    }
    if (arg === '--') {
      pastTerminator = true
      continue
    }
    if (!arg.startsWith('-') || arg === '-' || arg.startsWith('--')) {
      positional.push(arg)
      continue
    }

    const cluster = arg.slice(1)
    let cursor = 0
    let recognized = false
    while (cursor < cluster.length) {
      const flag = `-${cluster[cursor]}`
      if (boolSet.has(flag)) {
        flags.add(flag)
        cursor += 1
        recognized = true
        continue
      }
      if (valueSet.has(flag)) {
        const remainder = cluster.slice(cursor + 1)
        const value = remainder || args[++i] || ''
        values.set(flag, [...(values.get(flag) ?? []), value])
        recognized = true
        cursor = cluster.length
        continue
      }
      recognized = false
      break
    }
    if (!recognized) {
      positional.push(arg)
    }
  }

  return { flags, values, positional }
}

export function tmuxValue(parsed: ParsedTmuxArgs, flag: string): string | undefined {
  return parsed.values.get(flag)?.at(-1)
}

export function renderTmuxFormat(
  format: string | undefined,
  context: Record<string, string>,
  fallback: string
): string {
  if (!format) {
    return fallback
  }
  let rendered = format
  for (const [key, value] of Object.entries(context)) {
    rendered = rendered.replaceAll(`#{${key}}`, value)
  }
  rendered = rendered.replace(TMUX_FORMAT_VAR_RE, '').trim()
  return rendered || fallback
}

export function tmuxSendKeysText(tokens: string[], literal: boolean): string {
  if (literal) {
    return tokens.join(' ')
  }
  let result = ''
  let pendingSpace = false
  for (const token of tokens) {
    const special = tmuxSpecialKeyText(token)
    if (special !== null) {
      result += special
      pendingSpace = false
      continue
    }
    if (pendingSpace) {
      result += ' '
    }
    result += token
    pendingSpace = true
  }
  return result
}

function tmuxSpecialKeyText(token: string): string | null {
  switch (token.toLowerCase()) {
    case 'enter':
    case 'c-m':
    case 'kpenter':
      return '\r'
    case 'tab':
    case 'c-i':
      return '\t'
    case 'space':
      return ' '
    case 'bspace':
    case 'backspace':
      return '\x7f'
    case 'escape':
    case 'esc':
    case 'c-[':
      return '\x1b'
    case 'c-c':
      return '\x03'
    case 'c-d':
      return '\x04'
    case 'c-z':
      return '\x1a'
    case 'c-l':
      return '\x0c'
    default:
      return null
  }
}

export function isDirectClaudeCommand(command: string | undefined): boolean {
  const trimmed = command?.trim() ?? ''
  if (!trimmed) {
    return false
  }
  if (/[;&|<>`]/.test(trimmed)) {
    return false
  }
  const first = trimmed.match(/^\S+/)?.[0] ?? ''
  return first === 'claude' || first.endsWith('/claude')
}

export function addClaudeTeammateModeAuto(command: string): string {
  if (/(^|\s)--teammate-mode(?:\s|=|$)/.test(command)) {
    return command
  }
  return command.replace(/^(\S+)/, '$1 --teammate-mode auto')
}

export function addClaudeTeammateModeInProcess(command: string): string {
  if (/(^|\s)--teammate-mode(?:\s|=|$)/.test(command)) {
    return command
  }
  return command.replace(/^(\S+)/, '$1 --teammate-mode in-process')
}
