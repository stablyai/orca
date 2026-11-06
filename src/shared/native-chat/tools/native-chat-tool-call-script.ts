import { nativeChatFullCommand } from './native-chat-tool-input-text'
import {
  powershellAnalysisScript,
  powershellInvocationScript,
  powershellWords
} from './native-chat-powershell-script'
import { posixShellWords } from './native-chat-tool-preview-prefix'

// Decodes the script a shell tool call ran into POSIX-readable text for command analysis. A line that
// is one PowerShell or cmd launch, read in the quoting of what ran it, gives the script it runs.

const SHELL_PROGRAM = /^(?:ba|z|k|da|fi)?sh(?:\.exe)?$/iu
const SHELL_SCRIPT_FLAG = /^-[a-zA-Z]*c$/u
const POWERSHELL_PROGRAM = /^(?:pwsh|powershell)(?:\.exe)?$/iu
const CMD_PROGRAM = /^cmd(?:\.exe)?$/iu
const CMD_FLAG = /^\/[ds]$/iu
// Node's Windows shell form, in cmd's own quoting: `C:\Windows\System32\cmd.exe /d /s /c "script"`,
// the whole line, its script one quoted string.
const CMD_WRAPPER = /^(?:\/d\s+)?(?:\/s\s+)?\/c\s+"([\s\S]*)"$/iu

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

/** The script a decoded launch line runs, PowerShell's or cmd's: null when it can't be read whole,
 *  undefined when the line launches neither. */
function launchedScript(words: readonly string[]): string | null | undefined {
  const program = programName(words[0] ?? '')
  if (POWERSHELL_PROGRAM.test(program)) {
    return powershellInvocationScript(words)
  }
  if (CMD_PROGRAM.test(program)) {
    let index = 1
    while (CMD_FLAG.test(words[index] ?? '')) {
      index += 1
    }
    return /^\/c$/iu.test(words[index] ?? '') && index + 1 < words.length
      ? words.slice(index + 1).join(' ')
      : undefined
  }
  return undefined
}

/** The script of Node's Windows shell form as a whole line, which a bare Windows path can't be read
 *  as POSIX for. */
function cmdShellFormScript(command: string): string | null {
  const first = /^\s*(?:"([^"]+)"|(\S+))/u.exec(command)
  if (!first || !CMD_PROGRAM.test(programName(first[1] ?? first[2] ?? ''))) {
    return null
  }
  const script = CMD_WRAPPER.exec(command.slice(first.index + first[0].length).trim())?.[1]
  return script?.trim() ? script : null
}

/** The script a shell tool call ran, as POSIX-readable text; null when there is none to read.
 *  An argv `[sh, -lc, script]` keeps its script whole, since joining it would leave the command
 *  after the wrapper instead of at a command start. */
export function nativeChatToolCallScript(name: string, input: unknown): string | null {
  const argv = argvCommand(input)
  if (argv) {
    const launched = launchedScript(argv)
    if (launched !== undefined) {
      return launched
    }
    if (
      argv.length === 3 &&
      SHELL_PROGRAM.test(programName(argv[0]!)) &&
      SHELL_SCRIPT_FLAG.test(argv[1]!)
    ) {
      return argv[2]!
    }
  }
  const command = nativeChatFullCommand(input)
  if (command === null) {
    return null
  }
  if (name.trim().toLowerCase() !== 'powershell') {
    // Only a whole line is unwrapped, as the common pattern does: a launch inside a command list
    // stays text, never rebuilt into commands its comments or heredocs only mention.
    const words = posixShellWords(command)
    const launched = words ? launchedScript(words) : undefined
    return launched !== undefined ? launched : (cmdShellFormScript(command) ?? command)
  }
  // A tool that is PowerShell itself reads its line in PowerShell's quoting, and runs any command
  // that launches nothing as a PowerShell script.
  const words = powershellWords(command)
  const launched = words ? launchedScript(words) : undefined
  return launched !== undefined ? launched : powershellAnalysisScript(command)
}
