// A synthesized saved restore of an env-owned agent store asks Orca, from inside the agent's own
// shell function, whether its conversation still exists in the store this invocation will read.
// Only Orca's generated startup line carries the single-use proof; a typed command never does.

/** Command-scoped on POSIX/fish lines; Orca's function reads and unsets it before anything runs. */
export const SAVED_RESTORE_PROOF_ENV = 'ORCA_SAVED_RESTORE_PROOF'
/** The pane's bundled CLI; inert without a proof. */
export const SAVED_RESTORE_CHECK_ENV = 'ORCA_SAVED_RESTORE_CHECK'
/** Main's prebuilt fresh argument tail: portable-quoted for POSIX/fish, a JSON array for PowerShell. */
export const SAVED_RESTORE_FRESH_ARGS_ENV = 'ORCA_SAVED_RESTORE_FRESH_ARGS'
/** The check's whole budget in milliseconds, counted from the CLI's own start. */
export const SAVED_RESTORE_BUDGET_ENV = 'ORCA_SAVED_RESTORE_BUDGET_MS'
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
const POWERSHELL_PROOF_VARIABLE = 'OrcaSavedRestoreProof'
const PROOF_PATTERN = '[0-9a-f]{32}'

export function isSavedRestoreProof(value: unknown): value is string {
  return typeof value === 'string' && new RegExp(`^${PROOF_PATTERN}$`).test(value)
}

/** The generated line with its one-shot proof scoped to this command alone. */
export function withSavedRestoreProof(
  command: string,
  proof: string,
  shell: 'posix' | 'powershell'
): string {
  return shell === 'posix'
    ? `${SAVED_RESTORE_PROOF_ENV}=${proof} ${command}`
    : `$global:${POWERSHELL_PROOF_VARIABLE}='${proof}'; try { ${command} } finally { Remove-Variable -Scope Global ${POWERSHELL_PROOF_VARIABLE} -ErrorAction SilentlyContinue }`
}

const POSIX_PROOF_PREFIX = new RegExp(`^${SAVED_RESTORE_PROOF_ENV}=${PROOF_PATTERN} `)
const POWERSHELL_PROOF_WRAPPER = new RegExp(
  `^\\$global:${POWERSHELL_PROOF_VARIABLE}='${PROOF_PATTERN}'; try \\{ ([\\s\\S]*) \\} finally \\{ Remove-Variable -Scope Global ${POWERSHELL_PROOF_VARIABLE} -ErrorAction SilentlyContinue \\}$`
)

/** The agent command a proof-carrying line runs, for readers that recognize agents by command. */
export function withoutSavedRestoreProof(command: string): string {
  return command.replace(POSIX_PROOF_PREFIX, '').replace(POWERSHELL_PROOF_WRAPPER, '$1')
}

const POSIX_CHECK = `"$${SAVED_RESTORE_CHECK_ENV}" ${SAVED_RESTORE_CHECK_COMMAND.join(' ')}`

/** bash/zsh: shared by Orca's agent functions; each agent's text defines them, so any one works alone. The check runs in the env the agent is about to get;
 *  exit ${SAVED_RESTORE_FRESH_EXIT_CODE} alone means start fresh. Any other outcome runs the original arguments. */
export function getPosixSavedRestoreFunctions(): string {
  return `__orca_saved_restore_check() {
  [ -n "\${2:-}" ] && [ -n "\${${SAVED_RESTORE_FRESH_ARGS_ENV}+x}" ] && [ -x "\${${SAVED_RESTORE_CHECK_ENV}:-}" ] || return 1
  local __orca_restore_agent="$1" __orca_restore_proof="$2"
  shift 2
  printf '%s\\0' "$@" | ${POSIX_CHECK} --agent "$__orca_restore_agent" --token "$__orca_restore_proof" >/dev/null 2>&1
  [ $? -eq ${SAVED_RESTORE_FRESH_EXIT_CODE} ]
}
__orca_saved_restore_dispatched() {
  ( ${POSIX_CHECK} --phase dispatched --token "$1" </dev/null >/dev/null 2>&1 & )
}
__orca_saved_restore_exec() {
  local __orca_restore_agent="$1" __orca_restore_proof="$2"
  shift 2
  ${posixSavedRestoreFreshArgs('"$__orca_restore_agent"', '__orca_restore_proof')}
  command "$__orca_restore_agent" "$@"
}
`
}

/** bash/zsh: replaces the function's arguments with main's fresh tail only on a fresh answer. */
export function posixSavedRestoreFreshArgs(agent: string, proofVariable: string): string {
  return `if __orca_saved_restore_check ${agent} "$${proofVariable}" "$@"; then
    eval "set -- $${SAVED_RESTORE_FRESH_ARGS_ENV}"
    __orca_saved_restore_dispatched "$${proofVariable}"
  fi`
}

/** bash/zsh: the first lines of an Orca agent function; the proof never reaches the agent. */
export function posixSavedRestoreProofLines(variable: string): string {
  return `local ${variable}="\${${SAVED_RESTORE_PROOF_ENV}:-}"
    unset ${SAVED_RESTORE_PROOF_ENV}`
}

/** fish: the proof read at the top of a function. */
export function fishSavedRestoreProofLines(): string {
  return `set -l __orca_restore_proof "$${SAVED_RESTORE_PROOF_ENV}"
    set -e ${SAVED_RESTORE_PROOF_ENV}`
}

/** fish: the check, run under `envPrefix` (an `env ...` prefix) when the agent gets a changed env. */
export function fishSavedRestoreCheck(agent: string, envPrefix = ''): string {
  return `if test -n "$__orca_restore_proof"; and test -x "$${SAVED_RESTORE_CHECK_ENV}"; and set -q ${SAVED_RESTORE_FRESH_ARGS_ENV}
      printf '%s\\0' $argv | ${envPrefix || 'command '}"$${SAVED_RESTORE_CHECK_ENV}" ${SAVED_RESTORE_CHECK_COMMAND.join(' ')} --agent ${agent} --token "$__orca_restore_proof" >/dev/null 2>/dev/null
      if test $status -eq ${SAVED_RESTORE_FRESH_EXIT_CODE}
        eval set argv $${SAVED_RESTORE_FRESH_ARGS_ENV}
        command sh -c '"$0" ${SAVED_RESTORE_CHECK_COMMAND.join(' ')} --phase dispatched --token "$1" </dev/null >/dev/null 2>&1 &' "$${SAVED_RESTORE_CHECK_ENV}" "$__orca_restore_proof"
      end
    end`
}

/** PowerShell: consumes the proof and returns @{ args = <fresh args> } only when Orca's check says
 *  start fresh. Kept compact: the whole bootstrap shares one encoded command line. */
export function getPowerShellSavedRestoreFunctions(): string {
  return `function Global:__OrcaSavedRestoreFresh($n, $a) {
    $p = $global:${POWERSHELL_PROOF_VARIABLE}; Remove-Variable -Scope Global ${POWERSHELL_PROOF_VARIABLE} -ea 0
    $c = $env:${SAVED_RESTORE_CHECK_ENV}
    if (-not $p -or -not $c -or $null -eq $env:${SAVED_RESTORE_FRESH_ARGS_ENV}) { return }
    try {
        (@($a | % { "$_" + [char]0 }) -join '') | & $c ${SAVED_RESTORE_CHECK_COMMAND.join(' ')} --agent $n --token $p *> $null
        if ($LASTEXITCODE -ne ${SAVED_RESTORE_FRESH_EXIT_CODE}) { return }
        $f = @{ args = @($env:${SAVED_RESTORE_FRESH_ARGS_ENV} | ConvertFrom-Json) }
        $s = New-Object Diagnostics.ProcessStartInfo $c, "${SAVED_RESTORE_CHECK_COMMAND.join(' ')} --phase dispatched --token $p"
        $s.UseShellExecute = $false; $s.CreateNoWindow = $true; $null = [Diagnostics.Process]::Start($s)
        $f
    } catch {}
}`
}

/** PowerShell: an agent function's check, where its arguments and env are final. `agent` is a
 *  PowerShell expression naming the agent. */
export function powerShellSavedRestoreCheck(agent: string): string {
  return `if ($global:${POWERSHELL_PROOF_VARIABLE}) { $orcaFresh = __OrcaSavedRestoreFresh ${agent} $args; if ($orcaFresh) { $args = $orcaFresh.args } }`
}
