import { nativeChatToolInputText } from './native-chat-tool-input-text'

// A tool named after its shell ran there, whatever the host's own shell is.
const LANGUAGE_BY_TOOL_NAME: ReadonlyMap<string, string> = new Map([
  ['bash', 'shellscript'],
  ['powershell', 'powershell']
])

// The program a generic command tool spawned to run the command.
const LANGUAGE_BY_SHELL_PROGRAM: ReadonlyMap<string, string> = new Map([
  ['bash', 'shellscript'],
  ['sh', 'shellscript'],
  ['zsh', 'shellscript'],
  ['dash', 'shellscript'],
  ['ksh', 'shellscript'],
  ['wsl', 'shellscript'],
  ['fish', 'fish'],
  ['pwsh', 'powershell'],
  ['powershell', 'powershell'],
  ['cmd', 'bat']
])

// The first word, quoted or bare, when arguments follow it.
const PROGRAM_WITH_ARGUMENTS = /^\s*(?:"([^"]+)"|'([^']+)'|(\S+))\s+\S/

function shellProgram(command: string): string | null {
  const match = PROGRAM_WITH_ARGUMENTS.exec(command)
  const path = match?.[1] ?? match?.[2] ?? match?.[3]
  const name = path?.split(/[\\/]/).at(-1)?.toLowerCase()
  return name?.replace(/\.exe$/, '') ?? null
}

/**
 * The grammar for a command row, from the shell the command actually ran in: a
 * tool named after its shell, or the shell program the agent wrapped the
 * command in. Null when neither says, so the command stays plain.
 */
export function nativeChatCommandLanguage(toolName: string, input: unknown): string | null {
  const byName = LANGUAGE_BY_TOOL_NAME.get(toolName.trim().toLowerCase())
  if (byName) {
    return byName
  }
  const command = nativeChatToolInputText(input, 'command') || nativeChatToolInputText(input, 'cmd')
  const program = command ? shellProgram(command) : null
  return (program && LANGUAGE_BY_SHELL_PROGRAM.get(program)) ?? null
}
