// A command server's arguments as the server page's one line: quoted only where an argument needs it,
// and read back to the exact argv. Windows hosts keep backslashes as typed (no escapes there).
import { tokenizeCustomCommandTemplate } from '../../../../../shared/source-control/ai/generation/commit-message-prompt'
import { quotePosixShellUnlessPlain } from '../../../../../shared/shell/launch/shell-argument-quoting'

function quoteWindowsArg(arg: string): string | null {
  // Bare only when nothing in it is shell syntax the line's reader would refuse.
  if (/^[\w@%+=:,./\\-]+$/.test(arg)) {
    return arg
  }
  // Without escapes, a double quote can't sit inside a quoted argument.
  return arg.includes('"') ? null : `"${arg}"`
}

/** The line for `args`; null when one can't be written so it reads back the same (edit it as rows). */
export function formatMcpLaunchArgs(
  args: readonly string[],
  platform: NodeJS.Platform
): string | null {
  const words = args.map((arg) =>
    platform === 'win32' ? quoteWindowsArg(arg) : quotePosixShellUnlessPlain(arg)
  )
  if (words.some((word) => word === null)) {
    return null
  }
  const line = words.join(' ')
  // A line that wouldn't read back as these exact arguments isn't offered (newlines, $( on Windows).
  const back = parseMcpLaunchArgs(line, platform)
  return back && back.length === args.length && back.every((arg, index) => arg === args[index])
    ? line
    : null
}

/** The argv a typed line names; null for unbalanced quotes or shell syntax Orca won't run. */
export function parseMcpLaunchArgs(text: string, platform: NodeJS.Platform): string[] | null {
  if (/[\r\n]/.test(text)) {
    return null
  }
  const parsed = tokenizeCustomCommandTemplate(text, platform === 'win32' ? 'literal' : 'escape')
  if (!parsed.ok || parsed.spans.some((span) => span.divergesFromShell)) {
    return null
  }
  return parsed.tokens
}
