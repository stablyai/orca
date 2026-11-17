// Orca Cloud hooks for startup-command staging: on an Orca Cloud VM, Orca's own agent line is always
// staged and (in bash/zsh) leaves no echo or history entry.

/** Defaults to this process being orcad on an Orca Cloud VM (ORCA_IS_CLOUD=1, set by the image). */
export function isCloudStagingHost(cloudHost: boolean | undefined): boolean {
  return cloudHost ?? process.env.ORCA_IS_CLOUD === '1'
}

/** On a cloud host an Orca-built agent line is always staged, whatever its length. */
export function cloudHostStagesLine(args: {
  cloudHost?: boolean
  orcaBuiltLine?: boolean
}): boolean {
  return args.cloudHost === true && args.orcaBuiltLine === true
}

/** Shells whose prompt and history the cloud quiet prelude knows how to handle (CR-cmd-quiet). */
const QUIET_SHELLS = new Set(['bash', 'zsh'])

/**
 * On an Orca Cloud host the staged line is Orca's, not the user's, so it
 * leaves no trace. Runs first in the sourced script, before the agent draws:
 * - erases the rows the shell echoed for the prompt and the typed line, so the pane's first visible
 *   row is the agent's own output; nothing below them is touched;
 * - drops the line from bash's history (zsh skips it with the image's zshaddhistory hook, since zsh
 *   records a line before running it; the leading space also covers HISTCONTROL=ignorespace).
 * Errors from the launch still print: only the echo of the command is cleared.
 */
export function cloudQuietPrelude(typedLine: string, stagedPrefix: string): string {
  // Display width of the typed line (ASCII: a quoted /tmp path).
  const typedWidth = [...typedLine].length
  // String.raw: this is shell, so its backslashes and ${...} must reach the script as written.
  return String.raw`__orca_q_esc=$(printf '\033'); __orca_q_bel=$(printf '\007')
__orca_q_cols=${'$'}{COLUMNS:-0}
case $__orca_q_cols in '' | *[!0-9]* | 0) __orca_q_cols=$(tput cols 2>/dev/null || echo 80) ;; esac
__orca_q_prompt=
if [ -n "${'$'}{BASH_VERSION-}" ]; then
  eval '__orca_q_prompt=${'$'}{PS1@P}' 2>/dev/null
  __orca_q_h=$(HISTTIMEFORMAT= builtin history 1 2>/dev/null)
  case $__orca_q_h in
    *${stagedPrefix}*)
      __orca_q_h=${'$'}{__orca_q_h#"${'$'}{__orca_q_h%%[0-9]*}"}
      builtin history -d "${'$'}{__orca_q_h%%[!0-9]*}" 2>/dev/null
      ;;
  esac
elif [ -n "${'$'}{ZSH_VERSION-}" ]; then
  eval '__orca_q_prompt=${'$'}{(%)PS1}' 2>/dev/null
fi
__orca_q_prompt=$(printf '%s' "$__orca_q_prompt" | LC_ALL=C sed -e "s/${'$'}{__orca_q_esc}\[[0-9;?]*[ -\/]*[@-~]//g" -e "s/${'$'}{__orca_q_esc}\][^${'$'}{__orca_q_bel}]*${'$'}{__orca_q_bel}//g" | tr -d '\001\002' | tail -n 1)
__orca_q_rows=$(( (${'$'}{#__orca_q_prompt} + ${typedWidth} + __orca_q_cols - 1) / __orca_q_cols ))
[ "$__orca_q_rows" -ge 1 ] 2>/dev/null || __orca_q_rows=1
printf '\r\033[%dA\033[J' "$__orca_q_rows"
unset __orca_q_esc __orca_q_bel __orca_q_cols __orca_q_prompt __orca_q_h __orca_q_rows`
}

/**
 * CR-cmd-quiet: the line typed into the pane and the prelude the staged script runs first
 * ('' off a cloud host, for a user-authored line, or in a shell the prelude does not handle).
 */
export function cloudQuietStagedLine(args: {
  cloudHost: boolean
  orcaBuiltLine?: boolean
  shellName: string | null
  line: string
  stagedPrefix: string
}): { typedLine: string; prelude: string } {
  const quiet =
    args.cloudHost &&
    args.orcaBuiltLine === true &&
    args.shellName !== null &&
    QUIET_SHELLS.has(args.shellName)
  if (!quiet) {
    return { typedLine: args.line, prelude: '' }
  }
  // The leading space keeps it out of history wherever HISTCONTROL/HIST_IGNORE_SPACE is set.
  const typedLine = ` ${args.line}`
  return { typedLine, prelude: `${cloudQuietPrelude(typedLine, args.stagedPrefix)}\n` }
}
