/**
 * `claude` re-reads the which-account file on every launch, so a switch reaches open terminals
 * (superset's wrapper rule). Defined only in a pane Orca routed (pointer env set) where `claude` is
 * a real executable. A missing or empty file is System default, which restores the user's own value
 * Orca's replaced; a CLAUDE_CONFIG_DIR the user set, as opposed to Orca's twin-marked value, wins.
 * Prints nothing: an account folder with no login is created, and Claude's own first run signs in
 * there. The shell's Anthropic auth passes through untouched, as on System default. A pointer that names no absolute folder (never written by Orca) runs nothing, since any
 * fallback would be another account.
 */
export function getPosixClaudeShellFunction(): string {
  return `__orca_claude_binary="$(unalias claude 2>/dev/null || :; command -v claude 2>/dev/null || :)"
if [[ -n "\${ORCA_CLAUDE_PROFILE_POINTER:-}" && -n "\${__orca_claude_binary:-}" && -x "\${__orca_claude_binary}" ]]; then
  function claude {
    local __orca_claude_home __orca_claude_pointer="\${ORCA_CLAUDE_PROFILE_POINTER:-}"
    # Why: a WSL pane's pointer is relative to the guest home, which the host cannot know at spawn.
    case "$__orca_claude_pointer" in '~/'*) __orca_claude_pointer="\${HOME:-}/\${__orca_claude_pointer#??}" ;; esac
    __orca_claude_home="$(cat "$__orca_claude_pointer" 2>/dev/null || :)"
    if [ -n "\${CLAUDE_CONFIG_DIR:-}" ] && [ "$CLAUDE_CONFIG_DIR" != "\${ORCA_CLAUDE_INJECTED_CONFIG_DIR:-}" ]; then
      command claude "$@"; return
    fi
    # Why: Orca's value replaced the user's own at spawn, so System default restores theirs.
    if [ -z "$__orca_claude_home" ] && [ -n "\${CLAUDE_CONFIG_DIR:-}" ] && [ -n "\${ORCA_CLAUDE_USER_CONFIG_DIR:-}" ]; then
      ( unset ORCA_CLAUDE_INJECTED_CONFIG_DIR; export CLAUDE_CONFIG_DIR="$ORCA_CLAUDE_USER_CONFIG_DIR"; command claude "$@" ); return
    fi
    if [ -z "$__orca_claude_home" ]; then
      ( unset CLAUDE_CONFIG_DIR ORCA_CLAUDE_INJECTED_CONFIG_DIR; command claude "$@" ); return
    fi
    case "$__orca_claude_home" in /*|[A-Za-z]:*) ;; *) return 1 ;; esac
    # Why -m 700: matches the folder Orca's setup creates; a credentials folder stays private.
    [ -d "$__orca_claude_home" ] || mkdir -p -m 700 -- "$__orca_claude_home" 2>/dev/null
    ( export CLAUDE_CONFIG_DIR="$__orca_claude_home" ORCA_CLAUDE_INJECTED_CONFIG_DIR="$__orca_claude_home"; command claude "$@" )
  }
fi
unset __orca_claude_binary
`
}

/** Leading newline: the codex fragment it follows ends without one. */
export function getFishClaudeShellFunction(): string {
  return `
set -l __orca_claude_type (type -t claude 2>/dev/null)
if test -n "$ORCA_CLAUDE_PROFILE_POINTER"; and test "$__orca_claude_type" = file
  function claude
    # Why: a WSL pane's pointer is relative to the guest home, which the host cannot know at spawn.
    set -l pointer (string replace -r '^~/' "$HOME/" -- "$ORCA_CLAUDE_PROFILE_POINTER")
    set -l profile (cat "$pointer" 2>/dev/null)
    if test -n "$CLAUDE_CONFIG_DIR"; and test "$CLAUDE_CONFIG_DIR" != "$ORCA_CLAUDE_INJECTED_CONFIG_DIR"
      command claude $argv
      return $status
    end
    if test -z "$profile"; and test -n "$CLAUDE_CONFIG_DIR"; and test -n "$ORCA_CLAUDE_USER_CONFIG_DIR"
      env -u ORCA_CLAUDE_INJECTED_CONFIG_DIR CLAUDE_CONFIG_DIR="$ORCA_CLAUDE_USER_CONFIG_DIR" claude $argv
      return $status
    end
    if test -z "$profile"
      env -u CLAUDE_CONFIG_DIR -u ORCA_CLAUDE_INJECTED_CONFIG_DIR claude $argv
      return $status
    end
    if not string match -qr '^(/|[A-Za-z]:)' -- "$profile"
      return 1
    end
    test -d "$profile"; or mkdir -p -m 700 -- "$profile" 2>/dev/null
    env CLAUDE_CONFIG_DIR="$profile" ORCA_CLAUDE_INJECTED_CONFIG_DIR="$profile" claude $argv
  end
end
set -e __orca_claude_type
`
}

/** Leading newline: the codex fragment it follows ends without one. */
export function getPowerShellClaudeShellFunction(): string {
  return `
$orcaClaudeCommand = Get-Command claude -ErrorAction SilentlyContinue | Select-Object -First 1
if ($env:ORCA_CLAUDE_PROFILE_POINTER -and $orcaClaudeCommand -and
    $orcaClaudeCommand.CommandType -in @("Application", "ExternalScript")) {
function Global:claude {
    $names = @('CLAUDE_CONFIG_DIR', 'ORCA_CLAUDE_INJECTED_CONFIG_DIR')
    $saved = @{}
    foreach ($name in $names) { $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
    try {
        $orcaClaudeHome = ''
        if ($env:ORCA_CLAUDE_PROFILE_POINTER -and (Test-Path -LiteralPath $env:ORCA_CLAUDE_PROFILE_POINTER -PathType Leaf)) {
            $orcaClaudeHome = [IO.File]::ReadAllText($env:ORCA_CLAUDE_PROFILE_POINTER).TrimEnd()
        }
        if ($env:CLAUDE_CONFIG_DIR -and $env:CLAUDE_CONFIG_DIR -ne $env:ORCA_CLAUDE_INJECTED_CONFIG_DIR) {
            # The user's own value wins.
        } elseif (-not $orcaClaudeHome) {
            Remove-Item Env:ORCA_CLAUDE_INJECTED_CONFIG_DIR -ErrorAction SilentlyContinue
            if ($env:CLAUDE_CONFIG_DIR -and $env:ORCA_CLAUDE_USER_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR = $env:ORCA_CLAUDE_USER_CONFIG_DIR }
            else { Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue }
        } elseif (-not [IO.Path]::IsPathRooted($orcaClaudeHome)) {
            $global:LASTEXITCODE = 1
            return
        } else {
            if (-not [IO.Directory]::Exists($orcaClaudeHome)) { $null = New-Item -ItemType Directory -Path $orcaClaudeHome -Force -ErrorAction SilentlyContinue }
            $env:CLAUDE_CONFIG_DIR = $orcaClaudeHome
            $env:ORCA_CLAUDE_INJECTED_CONFIG_DIR = $orcaClaudeHome
        }
        $binary = Get-Command claude -CommandType Application,ExternalScript -ErrorAction Stop | Select-Object -First 1
        if ($MyInvocation.ExpectingInput) { $input | & $binary.Source @args } else { & $binary.Source @args }
        $global:LASTEXITCODE = $LASTEXITCODE
    } catch { $global:LASTEXITCODE = 1; Write-Error $_ -ErrorAction Continue }
    finally {
        # Why Remove-Item: on .NET 9+ a $null value (passed as "") creates the variable empty instead of deleting it.
        foreach ($name in $names) {
            if ($null -eq $saved[$name]) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
            else { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') }
        }
    }
}
}
Remove-Variable orcaClaudeCommand -ErrorAction SilentlyContinue
`
}
