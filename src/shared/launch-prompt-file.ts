/**
 * A launch prompt its command line cannot carry rides in a file the execution host writes; the
 * command line carries only a sentence pointing at it.
 */

import type { AgentStartupShell } from './tui-agent-startup-shell'

/** UTF-8 bytes a launch line carries to the agent's argv exactly (measured through staging in real
 *  shells); under Linux's 131,072-byte cap on one argument. */
export const MAX_LINE_PROMPT_BYTES = 100_000

/** Content the host that owns the PTY writes to a private file before anything names it. */
export type LaunchFile = {
  /** Stands in for the file's path in the command and env until the host substitutes it. */
  placeholder: string
  content: string
  /** How the launch line quoted the placeholder, set where the line is built; the host writes the
   *  path inside that quoting. Absent, the host accepts only a path every quoting carries as is. */
  quoting?: AgentStartupShell
}

const LAUNCH_LINE_QUOTINGS: readonly AgentStartupShell[] = ['posix', 'powershell', 'cmd']

const PLACEHOLDER_PATTERN = /^orca-launch-file-[0-9a-f]{32}$/

/** Stands in for the launch file's directory, which some agents must be granted to read it. */
export function launchFileDirectoryPlaceholder(placeholder: string): string {
  return placeholder.replace(/^orca-launch-file-/, 'orca-launch-dir-')
}

const POINTER_LEAD = 'The full task is in the file `'
const POINTER_TAIL = '`. Read it and complete the task it describes.'

// Why backticks, not quotes: PowerShell's legacy native-argument passing splits an argument at an
// inner `"`, while a backtick is literal in every shell's quoting and to the agent's argv parser.
export function buildLaunchFilePointer(path: string): string {
  return `${POINTER_LEAD}${path}${POINTER_TAIL}`
}

/** Whether an agent's prompt is Orca's pointer to a launch file rather than the user's own words. */
export function isLaunchFilePointer(prompt: string): boolean {
  const trimmed = prompt.trim()
  return (
    trimmed.startsWith(POINTER_LEAD) &&
    trimmed.endsWith(POINTER_TAIL) &&
    trimmed.length > POINTER_LEAD.length + POINTER_TAIL.length
  )
}

/** Whether text opens like Orca's pointer, as a session title cut from one does. */
export function opensLikeLaunchFilePointer(text: string): boolean {
  return text.trim().startsWith(POINTER_LEAD)
}

export function carryInLaunchFile(content: string): { prompt: string; launchFile: LaunchFile } {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  const placeholder = `orca-launch-file-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
  return {
    prompt: buildLaunchFilePointer(placeholder),
    launchFile: { placeholder, content }
  }
}

/** Validates a launch file received over a wire; the placeholder must be one Orca minted. */
export function parseLaunchFile(value: unknown): LaunchFile | undefined {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('placeholder' in value) ||
    !('content' in value)
  ) {
    return undefined
  }
  const { placeholder, content } = value
  const quoting = 'quoting' in value ? value.quoting : undefined
  const knownQuoting = LAUNCH_LINE_QUOTINGS.find((candidate) => candidate === quoting)
  if (
    typeof placeholder !== 'string' ||
    !PLACEHOLDER_PATTERN.test(placeholder) ||
    typeof content !== 'string' ||
    (quoting !== undefined && knownQuoting === undefined)
  ) {
    return undefined
  }
  return { placeholder, content, ...(knownQuoting ? { quoting: knownQuoting } : {}) }
}

/**
 * What a launch wants for an agent line too long or multi-line to type when the host cannot stage
 * it (its staging folder is unusable): `refuse` it, for a caller whose prompt main pasted, so the
 * user is handed the prompt instead of a raw line that can leave the shell waiting. Absent, the
 * host types the line as is, main's delivery where main typed it, as a host that predates the
 * field does. Set by the carry rule (`carryLaunchPrompt`), never by a caller.
 */
export type UnstageableLine = 'refuse'

export function parseUnstageableLine(value: unknown): UnstageableLine | undefined {
  return value === 'refuse' ? value : undefined
}

export const LAUNCH_FILE_UNAVAILABLE_CODE = 'launch_file_unavailable'

/** The refusal a host sends when it could not write what carries the prompt (a launch file, or the
 *  staged script holding a long line); it reaches the user as is. */
export function describeLaunchFileUnavailable(
  reason: string,
  carrier: 'file' | 'staged-line' = 'file'
): string {
  const what =
    carrier === 'file'
      ? "the file that carries the agent's prompt"
      : "the script that carries the agent's launch line and prompt"
  return `Orca could not write ${what} (${reason}), so the agent was not started. [${LAUNCH_FILE_UNAVAILABLE_CODE}]`
}

/** Matched by its code, wherever in the message a host or the IPC layer put it. */
export function isLaunchFileUnavailableMessage(message: string): boolean {
  return message.includes(LAUNCH_FILE_UNAVAILABLE_CODE)
}

/** The refusal as it reaches main from any host: its code is its type across process boundaries. */
export function isLaunchFileRefusal(error: unknown): boolean {
  return error instanceof Error && isLaunchFileUnavailableMessage(error.message)
}
