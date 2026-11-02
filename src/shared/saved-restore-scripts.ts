// Restore-only shell code, read by the root shell only when its launch was armed for a saved
// restore. Each agent's restore body comes from the same generator as its ordinary function, with
// the check inserted where its arguments and env are final; ordinary functions never read a proof.
import {
  fishClaudeFunction,
  posixClaudeFunction,
  powerShellClaudeFunction
} from './claude-shell-function'
import {
  fishCodexFunction,
  posixCodexFunction,
  powerShellCodexFunction
} from './codex-shell-function'
import {
  SAVED_RESTORE_CHECK_COMMAND,
  SAVED_RESTORE_CHECK_ENV,
  SAVED_RESTORE_FRESH_ARGS_ENV,
  SAVED_RESTORE_FRESH_EXIT_CODE
} from './saved-restore-dispatch'

const CHECK = SAVED_RESTORE_CHECK_COMMAND.join(' ')
const CLI = `"$${SAVED_RESTORE_CHECK_ENV}"`
const PASS_THROUGH = ['opencode', 'opencode2']

const POSIX_PROLOGUE = `
    local __orca_sr_d="$1" __orca_sr_t="$2"
    shift 2`
const posixCheck = (agent: string) => `
    if __orca_sr_check ${agent} "$__orca_sr_d" "$__orca_sr_t" "$@"; then
      eval "set -- $${SAVED_RESTORE_FRESH_ARGS_ENV}"
      __orca_sr_dispatched "$__orca_sr_d" "$__orca_sr_t"
    fi`
const posixFallback = (agent: string) =>
  `  __orca_sr_body_${agent}() { __orca_sr_exec ${agent} "$@"; }`

/** bash/zsh. Sourced after Orca's agent functions, so their definitions are snapshotted here. */
export function getPosixSavedRestoreScript(): string {
  return `__orca_sr_def_codex="$(typeset -f codex 2>/dev/null)"
__orca_sr_def_claude="$(typeset -f claude 2>/dev/null)"
__orca_sr_check() {
  [ -n "\${${SAVED_RESTORE_FRESH_ARGS_ENV}+x}" ] && [ -x "\${${SAVED_RESTORE_CHECK_ENV}:-}" ] || return 1
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
  shift 3
  if __orca_sr_check "$__orca_sr_agent" "$__orca_sr_d" "$__orca_sr_t" "$@"; then
    eval "set -- $${SAVED_RESTORE_FRESH_ARGS_ENV}"
    __orca_sr_dispatched "$__orca_sr_d" "$__orca_sr_t"
  fi
  command "$__orca_sr_agent" "$@"
}
# Why: only Orca's own function or a PATH binary may take the restore; an alias, the user's own
# function or anything uncertain runs the original line without the check.
__orca_sr_ours() {
  alias "$1" >/dev/null 2>&1 && return 1
  local __orca_sr_def
  __orca_sr_def="$(typeset -f "$1" 2>/dev/null)"
  if [ -n "$__orca_sr_def" ]; then
    case "$1" in
      codex) [ "$__orca_sr_def" = "$__orca_sr_def_codex" ] ;;
      claude) [ "$__orca_sr_def" = "$__orca_sr_def_claude" ] ;;
      *) return 1 ;;
    esac
    return
  fi
  case "$(command -v "$1" 2>/dev/null)" in /*) return 0 ;; esac
  return 1
}
__orca_sr_run() {
  local __orca_sr_d="$1" __orca_sr_t="$2" __orca_sr_orig="$3" __orca_sr_agent="$4"
  shift 4
  case "$__orca_sr_agent" in
    claude|codex|${PASS_THROUGH.join('|')}) __orca_sr_ours "$__orca_sr_agent" && { "__orca_sr_body_$__orca_sr_agent" "$__orca_sr_d" "$__orca_sr_t" "$@"; return; } ;;
  esac
  eval "$__orca_sr_orig"
}
if [ -n "$__orca_sr_def_codex" ]; then
${posixCodexFunction({ name: '__orca_sr_body_codex', prologue: POSIX_PROLOGUE, check: posixCheck('codex') })}
else
${posixFallback('codex')}
fi
if [ -n "$__orca_sr_def_claude" ]; then
${posixClaudeFunction({
  name: '__orca_sr_body_claude',
  prologue: POSIX_PROLOGUE,
  check: '',
  call: '__orca_sr_exec claude "$__orca_sr_d" "$__orca_sr_t" "$@"',
  fishCall: () => ''
})}
else
${posixFallback('claude')}
fi
${PASS_THROUGH.map(posixFallback).join('\n')}
# The entry erases itself before anything else, so a recalled line can never reach it again.
case "\${__orca_sr_entry:-}" in
  *[!0-9a-f]*|'') ;;
  *) [ \${#__orca_sr_entry} -eq 16 ] && eval "__orca_sr_\${__orca_sr_entry}() { unset -f __orca_sr_\${__orca_sr_entry}; __orca_sr_run \${__orca_sr_entry} \\"\\$@\\"; }" ;;
esac
`
}

const FISH_PROLOGUE = `
    set -l __orca_sr_d $argv[1]
    set -l __orca_sr_t $argv[2]
    set -e argv[1..2]`
/** fish 3.0 syntax only: no command-scoped assignments, no $(...), no string collect. */
const fishCheck = (agent: string, env = '') => `
    if test -x "$${SAVED_RESTORE_CHECK_ENV}"; and set -q ${SAVED_RESTORE_FRESH_ARGS_ENV}
      printf '%s\\0' $argv | ${env || 'command'} "$${SAVED_RESTORE_CHECK_ENV}" ${CHECK} --agent ${agent} --entry $__orca_sr_d --token $__orca_sr_t >/dev/null 2>/dev/null
      if test $status -eq ${SAVED_RESTORE_FRESH_EXIT_CODE}
        eval set argv $${SAVED_RESTORE_FRESH_ARGS_ENV}
        command sh -c '"$0" ${CHECK} --phase dispatched --entry "$1" --token "$2" </dev/null >/dev/null 2>&1 &' "$${SAVED_RESTORE_CHECK_ENV}" $__orca_sr_d $__orca_sr_t
      end
    end`
const fishFallback = (
  agent: string
) => `  function __orca_sr_body_${agent}${FISH_PROLOGUE}${fishCheck(agent)}
    command ${agent} $argv
  end`

export function getFishSavedRestoreScript(): string {
  return `set -g __orca_sr_def_codex (functions codex 2>/dev/null | string join \\n)
set -g __orca_sr_def_claude (functions claude 2>/dev/null | string join \\n)
function __orca_sr_ours
  functions -q $argv[1]; or begin
    string match -q -- '/*' (command -s $argv[1])
    return
  end
  set -l def (functions $argv[1] | string join \\n)
  switch $argv[1]
    case codex
      test "$def" = "$__orca_sr_def_codex"
    case claude
      test "$def" = "$__orca_sr_def_claude"
    case '*'
      false
  end
end
function __orca_sr_run
  set -l d $argv[1]
  set -l t $argv[2]
  set -l orig $argv[3]
  set -l agent $argv[4]
  set -e argv[1..4]
  if contains -- $agent claude codex ${PASS_THROUGH.join(' ')}; and __orca_sr_ours $agent
    switch $agent
${['claude', 'codex', ...PASS_THROUGH].map((agent) => `      case ${agent}\n        __orca_sr_body_${agent} $d $t $argv`).join('\n')}
    end
  else
    eval $orig
  end
end
if test -n "$__orca_sr_def_codex"
${fishCodexFunction({ name: '__orca_sr_body_codex', prologue: FISH_PROLOGUE, check: fishCheck('codex') })}
else
${fishFallback('codex')}
end
if test -n "$__orca_sr_def_claude"
${fishClaudeFunction({
  name: '__orca_sr_body_claude',
  prologue: FISH_PROLOGUE,
  check: '',
  call: '',
  fishCall: (env) =>
    `${fishCheck('claude', env)}\n    ${env ? `${env} claude` : 'command claude'} $argv`
})}
else
${fishFallback('claude')}
end
${PASS_THROUGH.map(fishFallback).join('\n')}
# The entry erases itself before anything else, so a recalled line can never reach it again.
if string match -qr '^[0-9a-f]{16}$' -- "$__orca_sr_entry"
  eval "function __orca_sr_$__orca_sr_entry; functions -e __orca_sr_$__orca_sr_entry; __orca_sr_run $__orca_sr_entry \\$argv; end"
end
`
}

const POWERSHELL_PROLOGUE = `
        $orcaSrD = $args[0]; $orcaSrT = $args[1]; $args = @($args | Select-Object -Skip 2)`
const POWERSHELL_CHECK = (agent: string) => `
        $orcaFresh = __OrcaSRFresh '${agent}' $orcaSrD $orcaSrT $args; if ($orcaFresh) { $args = $orcaFresh.args }`
const powerShellFallback = (agent: string) =>
  `function global:__OrcaSRBody_${agent} { __OrcaSRPass '${agent}' @args }`

/** Loaded from a file as inline script text only for an armed restore; never in the bootstrap. */
export function getPowerShellSavedRestoreScript(): string {
  return `$global:__OrcaSRDef = @{ codex = "\${function:codex}"; claude = "\${function:claude}" }
function global:__OrcaSRFresh($n, $d, $t, $a) {
    $c = $env:${SAVED_RESTORE_CHECK_ENV}
    if (-not $c -or $null -eq $env:${SAVED_RESTORE_FRESH_ARGS_ENV}) { return }
    try {
        (@($a | ForEach-Object { "$_" + [char]0 }) -join '') | & $c ${CHECK} --agent $n --entry $d --token $t *> $null
        if ($LASTEXITCODE -ne ${SAVED_RESTORE_FRESH_EXIT_CODE}) { return }
        $f = @{ args = @($env:${SAVED_RESTORE_FRESH_ARGS_ENV} | ConvertFrom-Json) }
        $s = New-Object Diagnostics.ProcessStartInfo $c, "${CHECK} --phase dispatched --entry $d --token $t"
        $s.UseShellExecute = $false; $s.CreateNoWindow = $true; $null = [Diagnostics.Process]::Start($s)
        $f
    } catch {}
}
# Why the original call convention: an external agent gets its arguments exactly as the line gave them.
function global:__OrcaSRPass {
    $n = $args[0]; $a = @($args | Select-Object -Skip 3)
    $f = __OrcaSRFresh $n $args[1] $args[2] $a; if ($f) { $a = $f.args }
    $b = Get-Command $n -CommandType Application,ExternalScript -ErrorAction Stop | Select-Object -First 1
    & $b.Source @a
    $global:LASTEXITCODE = $LASTEXITCODE
}
function global:__OrcaSRRun {
    $d = $args[0]; $t = $args[1]; $orig = $args[2]; $agent = $args[3]; $rest = @($args | Select-Object -Skip 4)
    $cmd = Get-Command $agent -ErrorAction SilentlyContinue | Select-Object -First 1
    $ours = $false
    if ($agent -in @('claude', 'codex', ${PASS_THROUGH.map((agent) => `'${agent}'`).join(', ')}) -and $cmd) {
        if ($cmd.CommandType -eq 'Function') { $ours = $global:__OrcaSRDef[$agent] -and "$($cmd.ScriptBlock)" -eq $global:__OrcaSRDef[$agent] }
        elseif ($cmd.CommandType -in @('Application', 'ExternalScript')) { $ours = [IO.Path]::IsPathRooted($cmd.Source) }
    }
    if ($ours) { & "__OrcaSRBody_$agent" $d $t @rest } else { Invoke-Expression $orig }
}
if ($global:__OrcaSRDef.codex) {
${powerShellCodexFunction({ name: '__OrcaSRBody_codex', prologue: POWERSHELL_PROLOGUE, check: POWERSHELL_CHECK('codex') })}
} else { ${powerShellFallback('codex')} }
if ($global:__OrcaSRDef.claude) {
${powerShellClaudeFunction({
  name: '__OrcaSRBody_claude',
  prologue: POWERSHELL_PROLOGUE,
  check: POWERSHELL_CHECK('claude'),
  call: '',
  fishCall: () => ''
})}
} else { ${powerShellFallback('claude')} }
${PASS_THROUGH.map(powerShellFallback).join('\n')}
# The entry erases itself before anything else, so a recalled line can never reach it again.
if ($orcaSrEntry -cmatch '^[0-9a-f]{16}$') {
    Set-Item "function:global:__orca_sr_$orcaSrEntry" ([scriptblock]::Create("Remove-Item function:__orca_sr_$orcaSrEntry; __OrcaSRRun '$orcaSrEntry' @args"))
}
`
}
