// Why: Claude Code hands the tmux shim a POSIX shell string for teammate panes —
// `cd <dir> && env K=V … <command>`. Executing it in the pane's shell only works where
// that shell is POSIX; PowerShell rejects `&&` and resolves `env` to nothing useful.
// Splitting it into cwd / env / bare command lets the pane be spawned through Orca's
// own options, so no shell syntax is emitted and every shell behaves the same.

export type ParsedTeammateCommand = {
  cwd?: string
  env: Record<string, string>
  command: string
}

type Token = { value: string; start: number; end: number }

const ENV_ASSIGNMENT_RE = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/

/**
 * Splits `cd <dir> && env K=V … <cmd>` into a working directory, environment and bare command.
 * An instruction that does not match that shape is returned unchanged.
 */
export function parseTeammateCommand(
  raw: string,
  platform: NodeJS.Platform = process.platform
): ParsedTeammateCommand {
  // Why: Claude splits a holding pane running `cat`, then immediately respawns it with the
  // real command. On Windows `cat` resolves to Get-Content, which blocks prompting for a
  // path; an empty command leaves a bare shell holding the pane just as well.
  if (raw.trim() === 'cat' && platform === 'win32') {
    return { env: {}, command: '' }
  }
  const tokens = tokenize(raw)
  let index = 0
  let cwd: string | undefined

  if (tokens[index]?.value === 'cd' && tokens[index + 1] && tokens[index + 2]?.value === '&&') {
    cwd = tokens[index + 1]!.value
    index += 3
  }

  const env: Record<string, string> = {}
  let sawEnvPrefix = false
  if (tokens[index]?.value === 'env') {
    sawEnvPrefix = true
    index += 1
    while (index < tokens.length) {
      const match = ENV_ASSIGNMENT_RE.exec(tokens[index]!.value)
      if (!match) {
        break
      }
      env[match[1]!] = match[2]!
      index += 1
    }
  }

  // Why: slice the original text rather than rejoining tokens — rejoining would drop the
  // quotes around arguments such as a prompt containing spaces.
  const command = index < tokens.length ? raw.slice(tokens[index]!.start).trim() : ''

  // Why: `env cmd` with no assignments still has to lose its `env` prefix — PowerShell has no such
  // command — so the passthrough only applies when nothing at all was recognised.
  if (cwd === undefined && !sawEnvPrefix && Object.keys(env).length === 0) {
    return { env: {}, command: raw.trim() }
  }
  return cwd === undefined ? { env, command } : { cwd, env, command }
}

/** Splits on whitespace, unwrapping quoted runs, and records each token's offset in the input. */
function tokenize(input: string): Token[] {
  const tokens: Token[] = []
  let cursor = 0

  while (cursor < input.length) {
    while (cursor < input.length && /\s/.test(input[cursor]!)) {
      cursor += 1
    }
    if (cursor >= input.length) {
      break
    }

    const start = cursor
    let value = ''
    while (cursor < input.length && !/\s/.test(input[cursor]!)) {
      const char = input[cursor]!
      if (char === "'" || char === '"') {
        const closing = input.indexOf(char, cursor + 1)
        if (closing === -1) {
          value += input.slice(cursor + 1)
          cursor = input.length
          break
        }
        value += input.slice(cursor + 1, closing)
        cursor = closing + 1
        continue
      }
      value += char
      cursor += 1
    }
    tokens.push({ value, start, end: cursor })
  }

  return tokens
}
