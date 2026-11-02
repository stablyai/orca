// Restore-only definitions, read by the root shell only when it owns a saved restore's start.
// The private action takes the restore only for a function Orca itself defined (recorded where it
// defined it) or a plain PATH executable; an alias, the user's own function or anything uncertain
// runs the plain command exactly as typed, with no check. Each agent's restore body comes from the
// same generator as its ordinary function, with the check where its arguments and env are final.
import {
  fishClaudeFunction,
  posixClaudeFunction,
  powerShellClaudeFunction
} from './claude-shell-function'
import {
  fishCodexFunction,
  posixCodexFunction,
  powerShellCodexFunction,
  PUBLIC_CODEX_VARIANT
} from './codex-shell-function'
import { PUBLIC_CLAUDE_VARIANT } from './claude-shell-function'
import {
  SAVED_RESTORE_CHECK_COMMAND,
  SAVED_RESTORE_CHECK_ENV,
  SAVED_RESTORE_FRESH_EXIT_CODE
} from './saved-restore-dispatch'
import { quoteStartupArg } from './tui-agent-startup-shell'

const CHECK = SAVED_RESTORE_CHECK_COMMAND.join(' ')
const CLI = `"$${SAVED_RESTORE_CHECK_ENV}"`
const FRESH = '${__orca_sr_fresh[@]+"${__orca_sr_fresh[@]}"}'
const RESUME = '${__orca_sr_resume[@]+"${__orca_sr_resume[@]}"}'

const POSIX_PROLOGUE = `
    local __orca_sr_d="$1" __orca_sr_t="$2"
    shift 2`
const posixCheck = (agent: string) => `
    if __orca_sr_check ${agent} "$__orca_sr_d" "$__orca_sr_t" "$@"; then
      set -- ${FRESH}
      __orca_sr_dispatched "$__orca_sr_d" "$__orca_sr_t"
    fi`

/** bash/zsh. */
export function getPosixSavedRestoreScript(): string {
  return `__orca_sr_check() {
  [ -x "\${${SAVED_RESTORE_CHECK_ENV}:-}" ] || return 1
  local __orca_sr_agent="$1" __orca_sr_e="$2" __orca_sr_k="$3"
  shift 3
  printf '%s\\0' "$@" | ${CLI} ${CHECK} --agent "$__orca_sr_agent" --entry "$__orca_sr_e" --token "$__orca_sr_k" >/dev/null 2>&1
  [ $? -eq ${SAVED_RESTORE_FRESH_EXIT_CODE} ]
}
__orca_sr_dispatched() {
  ( ${CLI} ${CHECK} --phase dispatched --entry "$1" --token "$2" </dev/null >/dev/null 2>&1 & )
}
__orca_sr_exec() {
  local __orca_sr_agent="$1" __orca_sr_d="$2" __orca_sr_t="$3"
  shift 3${posixCheck('"$__orca_sr_agent"')}
  command "$__orca_sr_agent" "$@"
}
__orca_sr_proven() {
  alias "$1" >/dev/null 2>&1 && return 1
  local __orca_sr_now __orca_sr_ours=""
  __orca_sr_now="$(typeset -f "$1" 2>/dev/null)"
  if [ -n "$__orca_sr_now" ]; then
    case "$1" in
      codex) __orca_sr_ours="\${__orca_sr_def_codex:-}" ;;
      claude) __orca_sr_ours="\${__orca_sr_def_claude:-}" ;;
    esac
    [ -n "$__orca_sr_ours" ] && [ "$__orca_sr_now" = "$__orca_sr_ours" ]
    return
  fi
  case "$(command -v "$1" 2>/dev/null)" in /*) return 0 ;; esac
  return 1
}
__orca_sr_run() {
  if ! __orca_sr_proven "$__orca_sr_agent"; then
    eval "$1"
    return
  fi
  case "$__orca_sr_agent" in
    codex|claude) [ -n "$(typeset -f "$__orca_sr_agent")" ] && { "__orca_sr_body_$__orca_sr_agent" "$__orca_sr_entry" "$__orca_sr_token" ${RESUME}; return; } ;;
  esac
  __orca_sr_exec "$__orca_sr_agent" "$__orca_sr_entry" "$__orca_sr_token" ${RESUME}
}
${posixCodexFunction({ name: '__orca_sr_body_codex', prologue: POSIX_PROLOGUE, check: posixCheck('codex') })}
${posixClaudeFunction({
  ...PUBLIC_CLAUDE_VARIANT,
  name: '__orca_sr_body_claude',
  prologue: POSIX_PROLOGUE,
  call: '__orca_sr_exec claude "$__orca_sr_d" "$__orca_sr_t" "$@"'
})}
`
}

const FISH_PROLOGUE = `
    set -l __orca_sr_d $argv[1]
    set -l __orca_sr_t $argv[2]
    set -e argv[1..2]`
/** fish 3.0 grammar: argv is replaced in the function that runs the agent, from a literal list. */
const fishCheck = (agent: string, env = '') => `
    if test -x "$${SAVED_RESTORE_CHECK_ENV}"
      printf '%s\\0' $argv | ${env || 'command'} "$${SAVED_RESTORE_CHECK_ENV}" ${CHECK} --agent ${agent} --entry $__orca_sr_d --token $__orca_sr_t >/dev/null 2>/dev/null
      if test $status -eq ${SAVED_RESTORE_FRESH_EXIT_CODE}
        set argv $__orca_sr_fresh
        command sh -c '"$0" ${CHECK} --phase dispatched --entry "$1" --token "$2" </dev/null >/dev/null 2>&1 &' "$${SAVED_RESTORE_CHECK_ENV}" $__orca_sr_d $__orca_sr_t
      end
    end`

export function getFishSavedRestoreScript(): string {
  return `function __orca_sr_exec
    set -l __orca_sr_a $argv[1]
    set -e argv[1]${FISH_PROLOGUE}${fishCheck('$__orca_sr_a')}
    command $__orca_sr_a $argv
end
function __orca_sr_proven
  set -l kind (type -t $argv[1] 2>/dev/null)
  if test "$kind" = function
    set -l now (functions $argv[1] | string join \\n)
    switch $argv[1]
      case codex
        test -n "$__orca_sr_def_codex"; and test "$now" = "$__orca_sr_def_codex"
      case claude
        test -n "$__orca_sr_def_claude"; and test "$now" = "$__orca_sr_def_claude"
      case '*'
        false
    end
    return
  end
  test "$kind" = file; and string match -q -- '/*' (command -s $argv[1])
end
function __orca_sr_run
  if not __orca_sr_proven $__orca_sr_agent
    eval $argv[1]
    return
  end
  switch (type -t $__orca_sr_agent)$__orca_sr_agent
    case functioncodex
      __orca_sr_body_codex $__orca_sr_entry $__orca_sr_token $__orca_sr_resume
    case functionclaude
      __orca_sr_body_claude $__orca_sr_entry $__orca_sr_token $__orca_sr_resume
    case '*'
      __orca_sr_exec $__orca_sr_agent $__orca_sr_entry $__orca_sr_token $__orca_sr_resume
  end
end
${fishCodexFunction({ name: '__orca_sr_body_codex', prologue: FISH_PROLOGUE, check: fishCheck('codex') })}
${fishClaudeFunction({
  ...PUBLIC_CLAUDE_VARIANT,
  name: '__orca_sr_body_claude',
  prologue: FISH_PROLOGUE,
  fishCall: (env) =>
    `${fishCheck('claude', env)}\n    ${env ? `${env} claude` : 'command claude'} $argv`
})}
`
}

/** The text PowerShell reports for Orca's own function: the body between its braces. */
function powerShellFunctionBody(text: string): string {
  return quoteStartupArg(text.slice(text.indexOf('{') + 1, text.lastIndexOf('}')), 'powershell')
}
const POWERSHELL_PROLOGUE = `
        $orcaSrD = $args[0]; $orcaSrT = $args[1]; $args = @($args | Select-Object -Skip 2)`
const POWERSHELL_CHECK = (agent: string) => `
        if (__OrcaSRFresh '${agent}' $orcaSrD $orcaSrT $args) { $args = $global:__OrcaSRFreshArgs }`

/** Loaded as inline script text only for a launch whose root owns a saved restore's start. */
export function getPowerShellSavedRestoreScript(): string {
  return `$global:__OrcaSRExpected = @{ codex = ${powerShellFunctionBody(powerShellCodexFunction(PUBLIC_CODEX_VARIANT))}; claude = ${powerShellFunctionBody(powerShellClaudeFunction(PUBLIC_CLAUDE_VARIANT))} }
function global:__OrcaSRFresh($n, $d, $t, $a) {
    $c = $env:${SAVED_RESTORE_CHECK_ENV}
    if (-not $c) { return $false }
    try {
        (@($a | ForEach-Object { "$_" + [char]0 }) -join '') | & $c ${CHECK} --agent $n --entry $d --token $t *> $null
        if ($LASTEXITCODE -ne ${SAVED_RESTORE_FRESH_EXIT_CODE}) { return $false }
        $global:__OrcaSRFreshArgs = [string[]]$global:__OrcaSRData.fresh
        $s = New-Object Diagnostics.ProcessStartInfo $c, "${CHECK} --phase dispatched --entry $d --token $t"
        $s.UseShellExecute = $false; $s.CreateNoWindow = $true; $null = [Diagnostics.Process]::Start($s)
        return $true
    } catch { return $false }
}
# Why the original call convention: an external agent gets its arguments exactly as the line gave them.
function global:__OrcaSRPass {
    $n = $args[0]; $a = [string[]]@($args | Select-Object -Skip 3)
    if (__OrcaSRFresh $n $args[1] $args[2] $a) { $a = $global:__OrcaSRFreshArgs }
    $b = Get-Command $n -CommandType Application,ExternalScript -ErrorAction Stop | Select-Object -First 1
    & $b.Source @a
    $global:LASTEXITCODE = $LASTEXITCODE
}
# One shot: the startup slot's own variable is consumed first, so no later call can take it.
function global:__OrcaSRStart {
    $line = $args[0]; $slot = $global:__OrcaSR
    Remove-Variable -Scope Global __OrcaSR -ErrorAction SilentlyContinue
    if (-not $slot) { Invoke-Expression $line; return }
    try { . ([scriptblock]::Create([IO.File]::ReadAllText("$($slot[0]).ps1"))) } catch { Invoke-Expression $line; return }
    $data = $global:__OrcaSRData
    $cmd = Get-Command $data.agent -ErrorAction SilentlyContinue | Select-Object -First 1
    $kind = if (-not $cmd) { '' } elseif ($cmd.CommandType -eq 'Function') { if ("$($cmd.ScriptBlock)" -ceq $global:__OrcaSRExpected[$data.agent]) { 'ours' } } elseif ($cmd.CommandType -in @('Application', 'ExternalScript') -and [IO.Path]::IsPathRooted($cmd.Source)) { 'plain' }
    if ($kind -eq 'ours') { & "__OrcaSRBody_$($data.agent)" $data.entry $data.token @($data.resume) }
    elseif ($kind -eq 'plain') { __OrcaSRPass $data.agent $data.entry $data.token @($data.resume) }
    else { Invoke-Expression $line }
}
${powerShellCodexFunction({ name: '__OrcaSRBody_codex', prologue: POWERSHELL_PROLOGUE, check: POWERSHELL_CHECK('codex') })}
${powerShellClaudeFunction({
  ...PUBLIC_CLAUDE_VARIANT,
  name: '__OrcaSRBody_claude',
  prologue: POWERSHELL_PROLOGUE,
  check: POWERSHELL_CHECK('claude')
})}
`
}
