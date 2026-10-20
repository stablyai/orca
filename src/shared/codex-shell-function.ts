// Orca's `codex` shell function for every shell family: runs launch prep and adds
// --no-daemon. Pure text, so any host that writes a shell script can embed it.
// Why --no-daemon: Codex 0.156+ otherwise shares one server per CODEX_HOME that runs every tab's
// hooks with the first tab's Orca env and dies with it (#22873).
// These args need that server (or exit 2 beside the flag), and Codex counts any `-c` as leaving it.
const CODEX_SHARED_SERVER_ARGS = ['agents', 'queue', '--remote'] as const
// An explicit --no-daemon needs no second one.
export const CODEX_NO_DAEMON_SKIP_ARGS = [...CODEX_SHARED_SERVER_ARGS, '--no-daemon'] as const
const argPattern = (args: readonly string[]): string => `^(${args.join('|')}|--remote=.*)$`
const CODEX_SHARED_SERVER_ARG_PATTERN = argPattern(CODEX_SHARED_SERVER_ARGS)
const CODEX_NO_DAEMON_SKIP_ARG_PATTERN = argPattern(CODEX_NO_DAEMON_SKIP_ARGS)

/**
 * The caller identity `orca` reads, which a user's `shell_environment_policy` (`inherit = "core"`)
 * strips from every command Codex runs (#25775). Codex applies `set` after `inherit` and `exclude`
 * (so an `exclude = ["ORCA_*"]` is overridden) but before `include_only`, which still wins. Never a
 * token: argv is readable by every local user.
 */
export const CODEX_COMMAND_IDENTITY_ENV_KEYS = [
  'ORCA_TERMINAL_HANDLE',
  'ORCA_PANE_KEY',
  'ORCA_WORKTREE_ID',
  'ORCA_WORKSPACE_ID',
  'ORCA_USER_DATA_PATH'
] as const

// Why values holding `'` are skipped: a TOML literal can't carry one, and Codex's fallback for the
// failed parse truncates some (`/a'`, `/a' #b`) — a wrong path is worse than none.
const identitySetArg = (key: string, value: string): string =>
  `shell_environment_policy.set.${key}='${value}'`

export function getPosixCodexShellLaunchPreflight(): string {
  return `# Why: a typed alias expands inside the shell, after pane launch prep.
# Why unalias inside the substitution: an alias named codex makes command -v
# report the alias text, and the subshell leaves the user's own alias intact.
# Why || : twice — zsh alone aborts inside the substitution, but every shell's
# assignment adopts its exit status, so an absent codex trips set -e in bash too.
__orca_codex_binary="$(unalias codex 2>/dev/null || :; command -v codex 2>/dev/null || :)"
if [[ -n "\${__orca_codex_binary:-}" && -x "\${__orca_codex_binary}" ]]; then
  # Why the function reserved word: it suppresses alias expansion of the name,
  # which otherwise rewrites this header at parse time and aborts the whole file.
  function codex {
    # Why local: zsh's warn_create_global warns for each global a function creates.
    local __orca_codex_arg __orca_codex_isolate="\${ORCA_CODEX_ISOLATE:-1}" __orca_codex_identity="\${ORCA_CODEX_ISOLATE:-1}"
    if [[ -n "\${ORCA_CODEX_LAUNCH_PREFLIGHT:-}" && -x "\${ORCA_CODEX_LAUNCH_PREFLIGHT}" ]]; then
      "\${ORCA_CODEX_LAUNCH_PREFLIGHT}" agent hooks prepare-codex >/dev/null 2>&1 || :
    fi
    for __orca_codex_arg in "$@"; do
      case "$__orca_codex_arg" in
        --no-daemon) __orca_codex_isolate=0 ;;
        ${CODEX_SHARED_SERVER_ARGS.join('|')}|--remote=*) __orca_codex_isolate=0 __orca_codex_identity=0 ;;
      esac
    done
    if [[ "$__orca_codex_identity" != 0 ]]; then
${CODEX_COMMAND_IDENTITY_ENV_KEYS.map((key) => `      [[ -z "\${${key}:-}" || "\${${key}}" == *"'"* ]] || set -- -c "${identitySetArg(key, `\${${key}}`)}" "$@"`).join('\n')}
    fi
    # Why probe every launch: a cached answer goes stale across an upgrade, and 0.155 and older exit 2 on the flag.
    if [[ "$__orca_codex_isolate" != 0 ]]; then
      case "$(command codex --help 2>/dev/null </dev/null)" in *--no-daemon*) set -- --no-daemon "$@" ;; esac
    fi
    command codex "$@"
  }
fi
unset __orca_codex_binary
`
}

export function getFishCodexShellLaunchPreflight(): string {
  return `# Why captured: an unquoted (type -t codex) expands to zero words when codex is
# absent, leaving "test = file" — fish then errors instead of failing closed.
# Quoting in place is not the fix; fish never substitutes inside double quotes.
set -l __orca_codex_type (type -t codex 2>/dev/null)
if test "$__orca_codex_type" = file
  function codex
    if test -x "$ORCA_CODEX_LAUNCH_PREFLIGHT"
      command "$ORCA_CODEX_LAUNCH_PREFLIGHT" agent hooks prepare-codex >/dev/null 2>&1; or true
    end
    if test "$ORCA_CODEX_ISOLATE" != 0; and not string match -qr -- '${CODEX_SHARED_SERVER_ARG_PATTERN}' $argv
${CODEX_COMMAND_IDENTITY_ENV_KEYS.map((key) => `      test -n "$${key}"; and not string match -q -- "*'*" "$${key}"; and set argv -c "${identitySetArg(key, `$${key}`)}" $argv`).join('\n')}
    end
    if test "$ORCA_CODEX_ISOLATE" != 0; and not string match -qr -- '${CODEX_NO_DAEMON_SKIP_ARG_PATTERN}' $argv; and command codex --help 2>/dev/null </dev/null | string match -q -- '*--no-daemon*'
      set argv --no-daemon $argv
    end
    command codex $argv
  end
end
set -e __orca_codex_type`
}

// Why the identity loop is one line: this wrapper rides in PowerShell's command-line budget
// (windows-shell-args.ts), which a long startup command also needs.
export function getPowerShellCodexShellLaunchPreflight(): string {
  return `$orcaCodexCommand = Get-Command codex -ErrorAction SilentlyContinue | Select-Object -First 1
if ($orcaCodexCommand -and
    $orcaCodexCommand.CommandType -in @("Application", "ExternalScript")) {
    function Global:codex {
        $orcaCodexExecutable = Get-Command codex -CommandType Application,ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $orcaCodexExecutable) {
            Write-Error "codex executable not found"
            $global:LASTEXITCODE = 127
            return
        }
        $orcaCodexFlags = @()
        # Why try/catch: under the user's $ErrorActionPreference = 'Stop', a failing prep or probe must not abort the launch.
        if ($env:ORCA_CODEX_LAUNCH_PREFLIGHT) {
            try {
                & $env:ORCA_CODEX_LAUNCH_PREFLIGHT agent hooks prepare-codex *> $null
            } catch {
            }
        }
        if ($env:ORCA_CODEX_ISOLATE -ne '0' -and -not (@($args) -cmatch '${CODEX_NO_DAEMON_SKIP_ARG_PATTERN}')) {
            try {
                if ((& $orcaCodexExecutable.Source --help 2>$null) -match '--no-daemon') {
                    $orcaCodexFlags = @('--no-daemon')
                }
            } catch {
            }
        }
        $orcaCodexIdentity = @()
        if ($env:ORCA_CODEX_ISOLATE -ne '0' -and -not (@($args) -cmatch '${CODEX_SHARED_SERVER_ARG_PATTERN}')) {
            foreach ($k in ${CODEX_COMMAND_IDENTITY_ENV_KEYS.map((key) => `'${key}'`).join(',')}) { $v = [Environment]::GetEnvironmentVariable($k); if ($v -and -not $v.Contains("'")) { $orcaCodexIdentity += '-c', "${identitySetArg('$k', '$v')}" } }
        }
        $orcaCodexArgs = @(__OrcaEscapeNativeArgs $orcaCodexExecutable.Source (@($orcaCodexIdentity) + @($args)))
        # Why: a native command inside a function never sees the function's pipeline input on its own.
        if ($MyInvocation.ExpectingInput) {
            $input | & $orcaCodexExecutable.Source @orcaCodexFlags @orcaCodexArgs
        } else {
            & $orcaCodexExecutable.Source @orcaCodexFlags @orcaCodexArgs
        }
        $global:LASTEXITCODE = $LASTEXITCODE
    }
}
Remove-Variable orcaCodexCommand -ErrorAction SilentlyContinue`
}
