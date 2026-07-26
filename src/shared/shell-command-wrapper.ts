/**
 * Opt-in template that wraps terminal/agent launch commands, e.g.
 * `devenv shell -- $CMD` so the project environment owns the process.
 *
 * Placeholders (checked longest-first so `$COMMAND` is not split by `$CMD`):
 * - `$CMD` (issue #10542)
 * - `$COMMAND`
 * - `{command}`
 *
 * The command is substituted as-is (already shell-quoted by callers). Do not
 * re-quote: `devenv shell -- $CMD` must expand to multiple argv tokens.
 * When no placeholder is present, the template is treated as a prefix.
 */

export const SHELL_COMMAND_WRAPPER_PLACEHOLDERS = ['$COMMAND', '$CMD', '{command}'] as const

export type ShellCommandWrapperPlaceholder = (typeof SHELL_COMMAND_WRAPPER_PLACEHOLDERS)[number]

export function normalizeShellCommandWrapper(
  wrapper: string | null | undefined
): string | undefined {
  const trimmed = wrapper?.trim()
  return trimmed ? trimmed : undefined
}

/**
 * Returns the wrapped command line, or the original command when the wrapper
 * is unset/blank or the command itself is blank.
 */
export function applyShellCommandWrapper(
  wrapper: string | null | undefined,
  command: string | null | undefined
): string {
  const normalizedCommand = command?.trim() ?? ''
  if (!normalizedCommand) {
    return command?.trim() === '' ? '' : (command ?? '')
  }
  const normalizedWrapper = normalizeShellCommandWrapper(wrapper)
  if (!normalizedWrapper) {
    return normalizedCommand
  }

  // Why: replace every variant ($CMD, $COMMAND, {command}) — stop-after-first
  // leaves mixed templates like `echo $CMD && {command}` half-substituted.
  if (SHELL_COMMAND_WRAPPER_PLACEHOLDERS.some((placeholder) => normalizedWrapper.includes(placeholder))) {
    return SHELL_COMMAND_WRAPPER_PLACEHOLDERS.reduce(
      (wrapped, placeholder) => wrapped.split(placeholder).join(normalizedCommand),
      normalizedWrapper
    )
  }

  return `${normalizedWrapper} ${normalizedCommand}`
}
