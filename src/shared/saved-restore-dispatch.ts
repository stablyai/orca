// A synthesized saved restore of an env-owned agent store asks Orca, from inside the agent's own
// shell invocation, whether its conversation still exists in the store that invocation reads.
// The root shell owns that start: it shows and records only the plain resume command, and runs a
// private one-shot startup action that no typed or recalled line can reach.
import { quoteStartupArg } from './tui-agent-startup-shell'

/** The pane's bundled CLI; inert without the private startup action. */
export const SAVED_RESTORE_CHECK_ENV = 'ORCA_SAVED_RESTORE_CHECK'
/** The check's whole budget in milliseconds, counted from the CLI's own start. */
export const SAVED_RESTORE_BUDGET_ENV = 'ORCA_SAVED_RESTORE_BUDGET_MS'
/** The root shell's startup inputs: this launch's action data and the restore definitions (paths
 *  without extension), and the plain command it shows and falls back to. Orca's wrapper reads and
 *  removes them before user startup files run. */
export const SAVED_RESTORE_ACTION_ENV = 'ORCA_SAVED_RESTORE_ACTION'
export const SAVED_RESTORE_SCRIPT_ENV = 'ORCA_SAVED_RESTORE_SCRIPT'
export const SAVED_RESTORE_ORIGINAL_ENV = 'ORCA_SAVED_RESTORE_ORIGINAL'
const LAUNCH_ENV_KEYS = [
  SAVED_RESTORE_ACTION_ENV,
  SAVED_RESTORE_SCRIPT_ENV,
  SAVED_RESTORE_ORIGINAL_ENV,
  SAVED_RESTORE_CHECK_ENV,
  SAVED_RESTORE_BUDGET_ENV
]
export const SAVED_RESTORE_FRESH_EXIT_CODE = 75
/** The store selectors the check reports from the invocation's own env. */
export const SAVED_RESTORE_ROOT_KEYS = [
  'HOME',
  'USERPROFILE',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'XDG_DATA_HOME',
  'OPENCODE_DB'
] as const
export const SAVED_RESTORE_CHECK_COMMAND = ['agent', 'saved-restore-check'] as const
const READY_MARKER = '\\033]777;orca-shell-ready\\007'

export function hasSavedRestoreLaunch(
  env: Record<string, string | undefined> | undefined
): boolean {
  return Boolean(env?.[SAVED_RESTORE_ACTION_ENV])
}

/** A destination that can't own the startup gets the plain resume and no startup inputs. */
export function stripSavedRestoreLaunch(env: Record<string, string | undefined> | undefined): void {
  for (const key of env && hasSavedRestoreLaunch(env) ? LAUNCH_ENV_KEYS : []) {
    delete env![key]
  }
}

export function withoutSavedRestoreLaunch<Env extends Record<string, string> | undefined>(
  env: Env
): Env {
  if (!env || !hasSavedRestoreLaunch(env)) {
    return env
  }
  const rest = { ...env }
  stripSavedRestoreLaunch(rest)
  return rest
}

const isPowerShell = (shellPath: string) => /(^|[\\/])(powershell|pwsh)(\.exe)?$/i.test(shellPath)

/** Windows: only PowerShell carrying the startup slot in its encoded command owns the start. */
export function savedRestoreWindowsStartup(
  shellPath: string,
  command: string | undefined,
  env: Record<string, string | undefined> | undefined
): string | undefined {
  return command !== undefined && hasSavedRestoreLaunch(env) && isPowerShell(shellPath)
    ? renderPowerShellSavedRestoreStartup(command)
    : command
}

export function settleSavedRestoreWindowsLaunch(
  env: Record<string, string | undefined> | undefined,
  shellPath: string,
  startupInShellArgs: boolean
): void {
  if (!isPowerShell(shellPath) || !startupInShellArgs) {
    stripSavedRestoreLaunch(env)
  }
}

/** This launch's private data for each shell family; literal argument lists, never parsed text. */
export function getSavedRestoreActionFiles(data: {
  entry: string
  token: string
  agent: string
  resumeArgs: readonly string[]
  freshArgs: readonly string[]
}): { sh: string; fish: string; ps1: string } {
  const unix = (value: string) => quoteStartupArg(value, 'posix')
  const ps = (value: string) => quoteStartupArg(value, 'powershell')
  const list = (values: readonly string[], quote: (value: string) => string) =>
    values.map(quote).join(' ')
  const psList = (values: readonly string[]) => `@(${values.map(ps).join(', ')})`
  return {
    sh: `__orca_sr_entry=${data.entry} __orca_sr_token=${data.token} __orca_sr_agent=${data.agent}
__orca_sr_resume=(${list(data.resumeArgs, unix)})
__orca_sr_fresh=(${list(data.freshArgs, unix)})
`,
    fish: `set -g __orca_sr_entry ${data.entry}
set -g __orca_sr_token ${data.token}
set -g __orca_sr_agent ${data.agent}
set -g __orca_sr_resume ${list(data.resumeArgs, unix)}
set -g __orca_sr_fresh ${list(data.freshArgs, unix)}
`,
    ps1: `$global:__OrcaSRData = @{ entry = '${data.entry}'; token = '${data.token}'; agent = '${data.agent}'; resume = ${psList(data.resumeArgs)}; fresh = ${psList(data.freshArgs)} }
`
  }
}

/** bash/zsh, before user startup files: take the startup inputs into unexported shell state. */
export const POSIX_SAVED_RESTORE_CAPTURE = `__orca_sr_action="\${${SAVED_RESTORE_ACTION_ENV}:-}" __orca_sr_script="\${${SAVED_RESTORE_SCRIPT_ENV}:-}" __orca_sr_original="\${${SAVED_RESTORE_ORIGINAL_ENV}:-}"
builtin unset ${SAVED_RESTORE_ACTION_ENV} ${SAVED_RESTORE_SCRIPT_ENV} ${SAVED_RESTORE_ORIGINAL_ENV}`

/** bash/zsh, after Orca's agent functions: an armed root defines its one-shot startup action.
 *  It shows and records only the plain command, and runs it as typed if anything is missing. */
export const POSIX_SAVED_RESTORE_INSTALL = `if [ -n "\${__orca_sr_action:-}" ]; then
  __orca_sr_ready="\${__orca_ready_marker:-}"
  # One shot by consumption: the first call takes the inputs, so any later call does nothing.
  __orca_sr_prompt() {
    [ -n "\${__orca_sr_action:-}" ] || return 0
    local __orca_sr_line="$__orca_sr_original" __orca_sr_act="$__orca_sr_action" __orca_sr_defs="$__orca_sr_script"
    [ -z "\${__orca_sr_ready:-}" ] || printf '${READY_MARKER}'
    builtin unset __orca_sr_action __orca_sr_script __orca_sr_original __orca_sr_ready
    printf '%s\\n' "$__orca_sr_line"
    builtin history -s "$__orca_sr_line" 2>/dev/null || builtin print -s -- "$__orca_sr_line" 2>/dev/null
    if [ -r "$__orca_sr_defs.sh" ] && [ -r "$__orca_sr_act.sh" ] && . "$__orca_sr_defs.sh" && . "$__orca_sr_act.sh"; then
      __orca_sr_run "$__orca_sr_line"
    else
      eval "$__orca_sr_line"
    fi
  }
else
  builtin unset __orca_sr_action __orca_sr_script __orca_sr_original
fi`

/** fish -C (root argv only), before Orca's agent functions so their definitions are recorded. */
export const FISH_SAVED_RESTORE_CAPTURE = `set -g __orca_sr_action $${SAVED_RESTORE_ACTION_ENV}
set -g __orca_sr_script $${SAVED_RESTORE_SCRIPT_ENV}
set -g __orca_sr_original $${SAVED_RESTORE_ORIGINAL_ENV}
set -e ${SAVED_RESTORE_ACTION_ENV}
set -e ${SAVED_RESTORE_SCRIPT_ENV}
set -e ${SAVED_RESTORE_ORIGINAL_ENV}`

/** fish -C, after Orca's agent functions. The plain command is recorded with history append where
 *  fish has it; fish before 3.1 has no supported way to add an entry, so there it is only shown. */
export const FISH_SAVED_RESTORE_INSTALL = `function __orca_sr_prompt
  functions -e __orca_sr_prompt
  test -n "$__orca_sr_action"; or return 0
  set -l line $__orca_sr_original
  printf '%s\\n' "$line"
  builtin history append -- "$line" 2>/dev/null
  if test -r "$__orca_sr_script.fish"; and test -r "$__orca_sr_action.fish"; and source "$__orca_sr_script.fish"; and source "$__orca_sr_action.fish"
    set -e __orca_sr_action
    set -e __orca_sr_script
    set -e __orca_sr_original
    __orca_sr_run "$line"
  else
    set -e __orca_sr_action
    set -e __orca_sr_script
    set -e __orca_sr_original
    eval $line
  end
end`

/** PowerShell bootstrap, after Orca's agent wrappers: capture only. Constant size, so every
 *  PowerShell start carries the same short line whatever the launch. */
export const POWERSHELL_SAVED_RESTORE_INSTALL = `if ($env:${SAVED_RESTORE_ACTION_ENV}) { $global:__OrcaSR = @($env:${SAVED_RESTORE_ACTION_ENV}, $env:${SAVED_RESTORE_SCRIPT_ENV}); Remove-Item Env:${SAVED_RESTORE_ACTION_ENV}, Env:${SAVED_RESTORE_SCRIPT_ENV}, Env:${SAVED_RESTORE_ORIGINAL_ENV} -ea 0 }`

/** PowerShell's startup slot for an armed launch: load the restore definitions, then run the
 *  one-shot action, or the plain command when it isn't there. */
export function renderPowerShellSavedRestoreStartup(original: string): string {
  return `if ($global:__OrcaSR) { try { . ([scriptblock]::Create([IO.File]::ReadAllText("$($global:__OrcaSR[1]).ps1"))) } catch {} }; if (Get-Command __OrcaSRStart -ea 0) { __OrcaSRStart ${quoteStartupArg(original, 'powershell')} } else { ${original} }`
}
