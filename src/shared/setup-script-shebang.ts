// Why: the interpreter a setup/issue-command script is written for is a property of the script,
// not of the user's terminal preference, so a `#!` line is how a project declares it.

const POSIX_SHELL_BASENAMES = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash'])
const POWERSHELL_SHELL_BASENAMES = new Set(['pwsh', 'powershell'])
// Why: only the letters `set` itself accepts (`set [--abefhkmnptuvxBCHP] [-o option]`). An
// invocation-only flag such as `-l` or `-r` makes `set` exit 2, which under the runner's `set -e`
// aborts setup before its first line runs.
const SET_OPTION_FLAG_PATTERN = /^[-+][abefhkmnptuvxBCHP]+$/
// Why: `-o`/`-euo` name their option in the next token; a trailing `-o` with no name would make
// `set` dump the whole shell-option table into the setup terminal instead.
const SET_LONG_OPTION_FLAG_PATTERN = /^[-+][abefhkmnptuvxBCHP]*o$/
const SHELL_OPTION_NAME_PATTERN = /^[a-z_]+$/
export type SetupScriptShebang = {
  /** Lowercased interpreter basename, e.g. `bash` for `#!/usr/bin/env -S bash -e`. */
  interpreter: string
  /** Raw interpreter path or name declared in the shebang token, e.g. `C:\tools\pwsh.exe` or `bash`. */
  interpreterPath: string
  /** Interpreter flags the generated runner replays through `set`, e.g. `['-euo', 'pipefail']`. */
  shellOptions: string[]
}

/** True when `line` is a `#!` interpreter line (leading whitespace tolerated). */
export function isShebangLine(line: string): boolean {
  return line.trimStart().startsWith('#!')
}

/** Parses the script's leading `#!` line, or null when it has none. */
export function parseSetupScriptShebang(script: string): SetupScriptShebang | null {
  const firstLine = script.split('\n', 1)[0] ?? ''
  if (!isShebangLine(firstLine)) {
    return null
  }

  const tokens = tokenizeShebangLine(firstLine)
  const interpreterIndex = findInterpreterIndex(tokens)
  if (interpreterIndex === -1) {
    return null
  }
  const rawToken = tokens[interpreterIndex]
  return {
    interpreter: executableBasename(rawToken),
    interpreterPath: rawToken,
    shellOptions: parseShellOptions(tokens.slice(interpreterIndex + 1))
  }
}

/** True when the script's first line is a `#!` line naming a POSIX shell. */
export function scriptDeclaresPosixShell(script: string): boolean {
  const shebang = parseSetupScriptShebang(script)
  return shebang !== null && POSIX_SHELL_BASENAMES.has(shebang.interpreter)
}

/** True when the script's first line is a `#!` line naming PowerShell. */
export function scriptDeclaresPowerShell(script: string): boolean {
  const shebang = parseSetupScriptShebang(script)
  return shebang !== null && POWERSHELL_SHELL_BASENAMES.has(shebang.interpreter)
}

/** Returns the executable name ('pwsh.exe' or 'powershell.exe') when the script names PowerShell, or null. */
export function getPowerShellInterpreterExecutable(script: string): string | null {
  const shebang = parseSetupScriptShebang(script)
  if (!shebang || !POWERSHELL_SHELL_BASENAMES.has(shebang.interpreter)) {
    return null
  }
  if (shebang.interpreterPath.includes('/') || shebang.interpreterPath.includes('\\')) {
    return shebang.interpreterPath
  }
  return shebang.interpreter === 'pwsh' ? 'pwsh.exe' : 'powershell.exe'
}
/** Drops a leading `#!` line; the generated runner carries its own interpreter line. */
export function stripLeadingShebangLine(script: string): string {
  if (!isShebangLine(script.split('\n', 1)[0] ?? '')) {
    return script
  }
  const lineEnd = script.indexOf('\n')
  return lineEnd === -1 ? '' : script.slice(lineEnd + 1)
}

function tokenizeShebangLine(firstLine: string): string[] {
  const text = firstLine.trim().slice(2).trim()
  const tokens: string[] = []
  const regex = /(?:[^\s"']+|"[^"]*"|'[^']*')+/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    const raw = match[0]
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      tokens.push(raw.slice(1, -1))
    } else {
      tokens.push(raw)
    }
  }
  return tokens
}

function findInterpreterIndex(tokens: string[]): number {
  for (let index = 0; index < tokens.length; index++) {
    const basename = executableBasename(tokens[index])
    // Why: `env` (and its `-S` split-string form) only forwards to the real interpreter.
    if (basename === '' || basename === 'env' || basename.startsWith('-')) {
      continue
    }
    return index
  }
  return -1
}

function parseShellOptions(tokens: string[]): string[] {
  const options: string[] = []
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (SET_LONG_OPTION_FLAG_PATTERN.test(token)) {
      const optionName = tokens[index + 1]
      if (optionName && SHELL_OPTION_NAME_PATTERN.test(optionName)) {
        options.push(token, optionName)
        index++
      }
      continue
    }
    if (SET_OPTION_FLAG_PATTERN.test(token)) {
      options.push(token)
    }
  }
  return options
}

function executableBasename(token: string): string {
  return (
    token
      .replaceAll('\\', '/')
      .split('/')
      .pop()
      ?.toLowerCase()
      .replace(/\.exe$/, '') ?? ''
  )
}
