// Orca's `codex` shell function for every shell family: runs launch prep, adds
// --no-daemon, and carries Orca's status hook as a session flag from Orca's flag table. Pure text, so
// any host that writes a shell script can embed it.
// Why --no-daemon: Codex 0.156+ otherwise shares one server per CODEX_HOME that runs every tab's
// hooks with the first tab's Orca env and dies with it (#22873). These args need that server or exit 2.
export const CODEX_SHARED_SERVER_ARGS = ['agents', 'queue', '--no-daemon', '--remote'] as const
const CODEX_SHARED_SERVER_ARG_PATTERN = `^(${CODEX_SHARED_SERVER_ARGS.join('|')}|--remote=.*)$`
// Why a table read at each launch: the pane holds only the table's path, so an
// entry Orca derives or removes later reaches this pane's next launch. The
// directory exists only while Codex hooks are on, so without it nothing is probed.
// Why keyed by version: the flag approves the hook with the hash one Codex version
// computed, and a binary that hashes it differently would open its review screen.
// Why skip beside a file entry: an older Orca's entry in this home already posts status.
// Why skip beside the user's own `-c hooks...`: it replaces Orca's table, approval included.
export const ORCA_CODEX_HOOK_FLAGS_ENV = 'ORCA_CODEX_HOOK_FLAGS'
export const CODEX_HOOK_FLAG_ENTRY_SUFFIX = '.flag'
export const CODEX_HOOK_FLAG_NO_DAEMON_SUFFIX = '.no-daemon'
export const CODEX_HOOK_FLAG_REQUEST_SUFFIX = '.request'
/**
 * Raw hooks.json text of every Orca build's entry: the script path the
 * retired-form sweep matches (createManagedCommandMatcher), with either separator
 * (a JSON backslash is two characters).
 */
export const ORCA_CODEX_HOOK_FILE_ENTRY_NEEDLES = [
  'agent-hooks/codex-hook.',
  'agent-hooks\\\\codex-hook.'
] as const
/**
 * Whether `args` hold the user's own hooks override, in any spelling Codex
 * accepts: `-c hooks...`, `-chooks...`, `-c=hooks...`, `--config hooks...`,
 * `--config=hooks...`, with whitespace before the key.
 */
export function codexArgsOverrideHooks(args: readonly string[]): boolean {
  return args.some(
    (arg, index) =>
      /^(--config=|-c=?)\s*hooks[.=\s]/.test(arg) ||
      ((args[index - 1] === '-c' || args[index - 1] === '--config') && /^\s*hooks[.=\s]/.test(arg))
  )
}
const [SLASH_NEEDLE, BACKSLASH_NEEDLE] = ORCA_CODEX_HOOK_FILE_ENTRY_NEEDLES
// Why doubled for fish: its single quotes still read \\ as an escape.
const FISH_BACKSLASH_NEEDLE = BACKSLASH_NEEDLE.replaceAll('\\', '\\\\')

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
    local __orca_codex_arg __orca_codex_prev= __orca_codex_isolate="\${ORCA_CODEX_ISOLATE:-1}"
    local __orca_codex_user_hooks= __orca_codex_value= __orca_codex_version= __orca_codex_entry= __orca_codex_flag=
    if [[ -n "\${ORCA_CODEX_LAUNCH_PREFLIGHT:-}" && -x "\${ORCA_CODEX_LAUNCH_PREFLIGHT}" ]]; then
      "\${ORCA_CODEX_LAUNCH_PREFLIGHT}" agent hooks prepare-codex >/dev/null 2>&1 || :
    fi
    for __orca_codex_arg in "$@"; do
      case "$__orca_codex_arg" in ${CODEX_SHARED_SERVER_ARGS.join('|')}|--remote=*) __orca_codex_isolate=0 ;; esac
      __orca_codex_value=
      case "$__orca_codex_prev" in -c|--config) __orca_codex_value="$__orca_codex_arg" ;; esac
      case "$__orca_codex_arg" in
        --config=*) __orca_codex_value="\${__orca_codex_arg#--config=}" ;;
        -c?*) __orca_codex_value="\${__orca_codex_arg#-c}"; __orca_codex_value="\${__orca_codex_value#=}" ;;
      esac
      __orca_codex_value="\${__orca_codex_value#"\${__orca_codex_value%%[![:space:]]*}"}"
      case "$__orca_codex_value" in hooks[.=[:space:]]*) __orca_codex_user_hooks=1 ;; esac
      __orca_codex_prev="$__orca_codex_arg"
    done
    if [[ -n "\${ORCA_CODEX_HOOK_FLAGS:-}" && -d "\${ORCA_CODEX_HOOK_FLAGS}" ]]; then
      __orca_codex_version="$(command codex --version 2>/dev/null </dev/null)"
      if [[ -n "$__orca_codex_version" && "$__orca_codex_version" != */* ]]; then
        __orca_codex_entry="\${ORCA_CODEX_HOOK_FLAGS}/\${__orca_codex_version}"
      fi
      if [[ -n "$__orca_codex_entry" && ! -f "\${__orca_codex_entry}${CODEX_HOOK_FLAG_ENTRY_SUFFIX}" ]]; then
        # Why: Orca derives this binary's entry, so a later launch carries it.
        { printf '%s\\n' "$(unset -f codex 2>/dev/null; unalias codex 2>/dev/null; command -v codex 2>/dev/null)" >|"\${__orca_codex_entry}${CODEX_HOOK_FLAG_REQUEST_SUFFIX}"; } 2>/dev/null || :
        __orca_codex_entry=
      elif [[ -n "$__orca_codex_entry" && -z "$__orca_codex_user_hooks" ]] &&
        ! command grep -qF -e '${SLASH_NEEDLE}' -e '${BACKSLASH_NEEDLE}' "\${CODEX_HOME:-$HOME/.codex}/hooks.json" 2>/dev/null &&
        read -r __orca_codex_flag <"\${__orca_codex_entry}${CODEX_HOOK_FLAG_ENTRY_SUFFIX}" && [[ -n "$__orca_codex_flag" ]]; then
        set -- -c "$__orca_codex_flag" "$@"
      fi
    fi
    # Why probe on a miss only: the entry records whether its version accepts the flag, and 0.155 and older exit 2 on it.
    if [[ "$__orca_codex_isolate" != 0 ]]; then
      if [[ -n "$__orca_codex_entry" ]]; then
        if [[ -e "\${__orca_codex_entry}${CODEX_HOOK_FLAG_NO_DAEMON_SUFFIX}" ]]; then set -- --no-daemon "$@"; fi
      else
        case "$(command codex --help 2>/dev/null </dev/null)" in *--no-daemon*) set -- --no-daemon "$@" ;; esac
      fi
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
    set -l orca_codex_entry
    set -l orca_codex_user_hooks
    set -l orca_codex_prev
    for orca_codex_arg in $argv
      if string match -qr -- '^(--config=|-c=?)\\s*hooks[.=\\s]' $orca_codex_arg; or begin; contains -- "$orca_codex_prev" -c --config; and string match -qr -- '^\\s*hooks[.=\\s]' $orca_codex_arg; end
        set orca_codex_user_hooks 1
      end
      set orca_codex_prev $orca_codex_arg
    end
    if test -n "$ORCA_CODEX_HOOK_FLAGS"; and test -d "$ORCA_CODEX_HOOK_FLAGS"
      # Why a variable: fish before 3.4 has no quoted command substitution. Fish before 3.1 has no
      # string collect; its error is silenced, and the empty version then carries nothing.
      set -l orca_codex_version (command codex --version 2>/dev/null </dev/null | string collect 2>/dev/null)
      if test -n "$orca_codex_version"; and not string match -q -- '*/*' "$orca_codex_version"
        set orca_codex_entry "$ORCA_CODEX_HOOK_FLAGS/$orca_codex_version"
      end
      if test -n "$orca_codex_entry"; and not test -f "$orca_codex_entry${CODEX_HOOK_FLAG_ENTRY_SUFFIX}"
        # Why: Orca derives this binary's entry, so a later launch carries it.
        # Why sh: fish itself warns when a redirection fails, and 2>/dev/null cannot silence it.
        set -l orca_codex_path (command -s codex)
        command sh -c 'printf "%s\\n" "$1" >"$2"' sh "$orca_codex_path" "$orca_codex_entry${CODEX_HOOK_FLAG_REQUEST_SUFFIX}" 2>/dev/null
        set orca_codex_entry
      else if test -n "$orca_codex_entry"; and test -z "$orca_codex_user_hooks"
        set -l orca_codex_home $CODEX_HOME
        test -n "$orca_codex_home"; or set orca_codex_home $HOME/.codex
        set -l orca_codex_flag
        if not command grep -qF -e '${SLASH_NEEDLE}' -e '${FISH_BACKSLASH_NEEDLE}' $orca_codex_home/hooks.json 2>/dev/null; and read orca_codex_flag <"$orca_codex_entry${CODEX_HOOK_FLAG_ENTRY_SUFFIX}"; and test -n "$orca_codex_flag"
          set argv -c $orca_codex_flag $argv
        end
      end
    end
    # Why probe on a miss only: the entry records whether its version accepts the flag, and 0.155 and older exit 2 on it.
    if test "$ORCA_CODEX_ISOLATE" != 0; and not string match -qr -- '${CODEX_SHARED_SERVER_ARG_PATTERN}' $argv
      if test -n "$orca_codex_entry"
        if test -e "$orca_codex_entry${CODEX_HOOK_FLAG_NO_DAEMON_SUFFIX}"
          set argv --no-daemon $argv
        end
      else if command codex --help 2>/dev/null </dev/null | string match -q -- '*--no-daemon*'
        set argv --no-daemon $argv
      end
    end
    command codex $argv
  end
end
set -e __orca_codex_type`
}

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
        $orcaCodexEntry = $null
        $orcaCodexUserHooks = $false
        for ($orcaCodexIndex = 0; $orcaCodexIndex -lt $args.Count; $orcaCodexIndex++) {
            $orcaCodexArg = [string]$args[$orcaCodexIndex]
            $orcaCodexPrev = if ($orcaCodexIndex -gt 0) { [string]$args[$orcaCodexIndex - 1] } else { '' }
            if ($orcaCodexArg -cmatch '^(--config=|-c=?)\\s*hooks[.=\\s]' -or
                (($orcaCodexPrev -ceq '-c' -or $orcaCodexPrev -ceq '--config') -and $orcaCodexArg -cmatch '^\\s*hooks[.=\\s]')) {
                $orcaCodexUserHooks = $true
            }
        }
        if ($env:ORCA_CODEX_HOOK_FLAGS -and (Test-Path -LiteralPath $env:ORCA_CODEX_HOOK_FLAGS -PathType Container)) {
            try {
                # Why line by line: a cmd AutoRun under npm's codex.cmd can print before Codex's own line.
                $orcaCodexEntryPath = $null
                $orcaCodexMissPath = $null
                foreach ($orcaCodexLine in @(& $orcaCodexExecutable.Source --version 2>$null)) {
                    $orcaCodexVersion = ([string]$orcaCodexLine).Trim()
                    if (-not $orcaCodexVersion -or $orcaCodexVersion -match '[\\\\/:]') {
                        continue
                    }
                    $orcaCodexCandidate = Join-Path $env:ORCA_CODEX_HOOK_FLAGS $orcaCodexVersion
                    if (Test-Path -LiteralPath "$orcaCodexCandidate${CODEX_HOOK_FLAG_ENTRY_SUFFIX}" -PathType Leaf) {
                        $orcaCodexEntryPath = $orcaCodexCandidate
                        break
                    }
                    $orcaCodexMissPath = $orcaCodexCandidate
                }
                if (-not $orcaCodexEntryPath) {
                    if ($orcaCodexMissPath) {
                        # Why: Orca derives this binary's entry, so a later launch carries it.
                        Set-Content -LiteralPath "$orcaCodexMissPath${CODEX_HOOK_FLAG_REQUEST_SUFFIX}" -Value $orcaCodexExecutable.Source -Encoding UTF8 -ErrorAction SilentlyContinue
                    }
                } else {
                    $orcaCodexEntry = $orcaCodexEntryPath
                    $orcaCodexHome = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path $HOME '.codex' }
                    $orcaCodexHooks = Join-Path $orcaCodexHome 'hooks.json'
                    $orcaCodexFileEntry = (Test-Path -LiteralPath $orcaCodexHooks) -and
                        (Select-String -LiteralPath $orcaCodexHooks -SimpleMatch -Pattern @('${SLASH_NEEDLE}', '${BACKSLASH_NEEDLE}') -Quiet)
                    if (-not $orcaCodexUserHooks -and -not $orcaCodexFileEntry) {
                        $orcaCodexFlag = [string](Get-Content -LiteralPath "$orcaCodexEntryPath${CODEX_HOOK_FLAG_ENTRY_SUFFIX}" -TotalCount 1 -Encoding UTF8)
                        if ($orcaCodexFlag) {
                            $orcaCodexFlags = @('-c', $orcaCodexFlag)
                        }
                    }
                }
            } catch {
            }
        }
        # Why probe on a miss only: the entry records whether its version accepts the flag, and 0.155 and older exit 2 on it.
        if ($env:ORCA_CODEX_ISOLATE -ne '0' -and -not (@($args) -cmatch '${CODEX_SHARED_SERVER_ARG_PATTERN}')) {
            if ($orcaCodexEntry) {
                if (Test-Path -LiteralPath "$orcaCodexEntry${CODEX_HOOK_FLAG_NO_DAEMON_SUFFIX}") {
                    $orcaCodexFlags = @('--no-daemon') + $orcaCodexFlags
                }
            } else {
                try {
                    if ((& $orcaCodexExecutable.Source --help 2>$null) -match '--no-daemon') {
                        $orcaCodexFlags = @('--no-daemon') + $orcaCodexFlags
                    }
                } catch {
                }
            }
        }
        # Why: a native command inside a function never sees the function's pipeline input on its own.
        if ($MyInvocation.ExpectingInput) {
            $input | & $orcaCodexExecutable.Source @orcaCodexFlags @args
        } else {
            & $orcaCodexExecutable.Source @orcaCodexFlags @args
        }
        $global:LASTEXITCODE = $LASTEXITCODE
    }
}
Remove-Variable orcaCodexCommand -ErrorAction SilentlyContinue`
}
