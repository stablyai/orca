import { nativeChatToolInputText } from './native-chat-tool-input-text'
import {
  powershellAnalysisScript,
  powershellInvocationScript
} from './native-chat-powershell-script'
import { posixShellWords } from './native-chat-tool-preview-prefix'

// Decodes the script a shell tool call ran into POSIX-readable text for command analysis. Only the
// launch shapes agents are recorded writing are unwrapped, each in the quoting of what wrote it:
// argv, a shell's `-c` line, and Codex's Windows `pwsh -Command` line. Anything else is a miss, never
// a guess: cmd launches, and a launch nested inside a PowerShell tool's script, stay text.

const SHELL_PROGRAM = /^(?:ba|z|k|da|fi)?sh(?:\.exe)?$/iu
const SHELL_SCRIPT_FLAG = /^-[a-zA-Z]*c$/u
const POWERSHELL_PROGRAM = /^(?:pwsh|powershell)(?:\.exe)?$/iu
function programName(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? ''
}

function argvCommand(input: unknown): readonly string[] | null {
  let value = input
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return null
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return null
  }
  const argv =
    'command' in value && Array.isArray(value.command)
      ? value.command
      : 'cmd' in value
        ? value.cmd
        : null
  return Array.isArray(argv) && argv.every((part) => typeof part === 'string') ? argv : null
}

/** The script an argv or a decoded line launches: a shell's `-c` script, or PowerShell's
 *  `-Command` script. Null when PowerShell's can't be read whole, undefined for anything else. */
function launchedScript(words: readonly string[]): string | null | undefined {
  const program = programName(words[0] ?? '')
  if (POWERSHELL_PROGRAM.test(program)) {
    return powershellInvocationScript(words)
  }
  // Arguments after the script are its positional parameters (`$0`, `$1`), not commands.
  return words.length >= 3 && SHELL_PROGRAM.test(program) && SHELL_SCRIPT_FLAG.test(words[1]!)
    ? words[2]!
    : undefined
}

/** The script a shell tool call ran, as POSIX-readable text; null when there is none to read. */
export function nativeChatToolCallScript(name: string, input: unknown): string | null {
  const argv = argvCommand(input)
  if (argv) {
    // Joining an argv would turn its arguments into commands, so one that launches nothing known
    // has no script to read.
    return launchedScript(argv) ?? null
  }
  const command = (
    nativeChatToolInputText(input, 'command') || nativeChatToolInputText(input, 'cmd')
  )?.trim()
  if (!command) {
    return null
  }
  // A tool that is PowerShell itself runs its line as a PowerShell script.
  if (name.trim().toLowerCase() === 'powershell') {
    return powershellAnalysisScript(command)
  }
  // Only a whole line that is one launch is unwrapped, as the common pattern does: any other line
  // is analyzed as written, its comments, heredocs and other commands kept as they are.
  const words = posixShellWords(command)
  const launched = words ? launchedScript(words) : undefined
  return launched !== undefined ? launched : command
}
