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

/** Splits tmux argv into a subcommand and its remaining arguments. */
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

/** Parses tmux-style flags and positionals into a structured form. */
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

/** Reads a flag's value, or undefined when the flag is absent or boolean-only. */
export function tmuxValue(parsed: ParsedTmuxArgs, flag: string): string | undefined {
  return parsed.values.get(flag)?.at(-1)
}

/** Substitutes `#{...}` placeholders in a tmux format string. */
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

/** Converts send-keys tokens into the literal text to write to the pane. */
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

// Why: tmux names these keys; unmapped names fall through as literal text, so a
// missing entry types the key's name into the pane instead of moving the cursor.
const TMUX_NAMED_KEYS = new Map<string, string>([
  ['enter', '\r'],
  ['kpenter', '\r'],
  ['tab', '\t'],
  ['space', ' '],
  ['bspace', '\x7f'],
  ['backspace', '\x7f'],
  ['escape', '\x1b'],
  ['esc', '\x1b'],
  ['btab', '\x1b[Z'],
  ['up', '\x1b[A'],
  ['down', '\x1b[B'],
  ['right', '\x1b[C'],
  ['left', '\x1b[D'],
  ['home', '\x1b[H'],
  ['end', '\x1b[F'],
  ['ppage', '\x1b[5~'],
  ['pageup', '\x1b[5~'],
  ['npage', '\x1b[6~'],
  ['pagedown', '\x1b[6~'],
  ['ic', '\x1b[2~'],
  ['insert', '\x1b[2~'],
  ['dc', '\x1b[3~'],
  ['delete', '\x1b[3~']
])

/** The escape sequence for a named key or control chord, or null when the token is plain text. */
function tmuxSpecialKeyText(token: string): string | null {
  const key = token.toLowerCase()
  const named = TMUX_NAMED_KEYS.get(key)
  if (named !== undefined) {
    return named
  }
  // Why: masking with 0x1f is the ASCII control-code rule and covers both the
  // letters and the bracket chords (C-m is CR, C-i is TAB, C-[ is ESC).
  const chord = /^c-([a-z[\\\]^_])$/.exec(key)
  if (chord) {
    return String.fromCharCode(chord[1]!.charCodeAt(0) & 0x1f)
  }
  return null
}

/** Whether the command launches Claude directly rather than through a shell wrapper or pipeline. */
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

/** Adds `--teammate-mode auto`, making the native-panes intent explicit in the command. */
export function addClaudeTeammateModeAuto(command: string): string {
  if (/(^|\s)--teammate-mode(?:\s|=|$)/.test(command)) {
    return command
  }
  return command.replace(/^(\S+)/, '$1 --teammate-mode auto')
}

/** Adds `--teammate-mode in-process`, used where native panes are unsupported. */
export function addClaudeTeammateModeInProcess(command: string): string {
  if (/(^|\s)--teammate-mode(?:\s|=|$)/.test(command)) {
    return command
  }
  return command.replace(/^(\S+)/, '$1 --teammate-mode in-process')
}
