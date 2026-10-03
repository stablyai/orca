import { claudeProfileRoutingEnabled } from './claude-profile-routing'
const authHeaderWords = 'authorization|x-api-key|api-key|bearer'
const posixAuthHeaderPattern = authHeaderWords
  .split('|')
  .map((word) => `*${word.replace(/[a-z]/g, (letter) => `[${letter}${letter.toUpperCase()}]`)}*`)
  .join('|')

/**
 * These functions are inserted only when profile routing is enabled, and define `claude` only in a
 * pane the host routed (pointer env set) where `claude` is a real executable, like the codex function.
 * Orca re-reads the pointer only while CLAUDE_CONFIG_DIR is unset or still Orca's spawn value.
 */
export function getPosixClaudeShellFunction(): string {
  if (!claudeProfileRoutingEnabled()) {
    return ''
  }
  return `__orca_claude_binary="$(unalias claude 2>/dev/null || :; command -v claude 2>/dev/null || :)"
if [[ -n "\${ORCA_CLAUDE_PROFILE_POINTER:-}" && -n "\${__orca_claude_binary:-}" && -x "\${__orca_claude_binary}" ]]; then
  function claude {
    local __orca_claude_home __orca_claude_pointer="\${ORCA_CLAUDE_PROFILE_POINTER:-}"
    # Why: a WSL pane's pointer is guest-relative, since the host cannot know the guest home.
    case "$__orca_claude_pointer" in '~/'*) __orca_claude_pointer="\${HOME:-}/\${__orca_claude_pointer#??}" ;; esac
    if [ -n "\${CLAUDE_CONFIG_DIR:-}" ] && [ "$CLAUDE_CONFIG_DIR" != "\${ORCA_CLAUDE_INJECTED_CONFIG_DIR:-}" ]; then
      command claude "$@"; return
    fi
    if [ ! -f "$__orca_claude_pointer" ] || [ ! -r "$__orca_claude_pointer" ]; then
      printf '%s\\n' 'Claude account selection is unreadable; choose an account again.' >&2; return 1
    fi
    __orca_claude_home="$(LC_ALL=C tr '\\000' '\\n' < "$__orca_claude_pointer" && printf '.')" || { printf '%s\\n' 'Claude account selection is unreadable.' >&2; return 1; }
    __orca_claude_home="\${__orca_claude_home%.}"
    case "$__orca_claude_home" in *$'\\n'*|*$'\\r'*) printf '%s\\n' 'Invalid Claude account selection.' >&2; return 1 ;; esac
    if [ -n "$__orca_claude_home" ]; then
      # Why the drive form: Git Bash runs the Windows claude.exe against the host's Windows path.
      case "$__orca_claude_home" in /*|[A-Za-z]:[\\\\/]*) ;; *) printf '%s\\n' 'Invalid Claude account selection.' >&2; return 1 ;; esac
      if [ ! -d "$__orca_claude_home" ]; then printf '%s\\n' 'Selected Claude profile is missing.' >&2; return 1; fi
      ( unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN AWS_BEARER_TOKEN_BEDROCK; case "\${ANTHROPIC_CUSTOM_HEADERS:-}" in ${posixAuthHeaderPattern}) unset ANTHROPIC_CUSTOM_HEADERS ;; esac; export CLAUDE_CONFIG_DIR="$__orca_claude_home" ORCA_CLAUDE_INJECTED_CONFIG_DIR="$__orca_claude_home"; command claude "$@" )
    else
      ( unset CLAUDE_CONFIG_DIR ORCA_CLAUDE_INJECTED_CONFIG_DIR; command claude "$@" )
    fi
  }
fi
unset __orca_claude_binary
`
}

/** Leading newline: the codex fragment it follows ends without one. */
export function getFishClaudeShellFunction(): string {
  if (!claudeProfileRoutingEnabled()) {
    return ''
  }
  return `
set -l __orca_claude_type (type -t claude 2>/dev/null)
if test -n "$ORCA_CLAUDE_PROFILE_POINTER"; and test "$__orca_claude_type" = file
  function claude
    if test -n "$CLAUDE_CONFIG_DIR"; and test "$CLAUDE_CONFIG_DIR" != "$ORCA_CLAUDE_INJECTED_CONFIG_DIR"
      command claude $argv
      return $status
    end
    set -l pointer "$ORCA_CLAUDE_PROFILE_POINTER"
    # Why: a WSL pane's pointer is guest-relative, since the host cannot know the guest home.
    if string match -q '~/*' -- "$pointer"
      set pointer "$HOME/"(string sub -s 3 -- "$pointer")
    end
    if not test -f "$pointer"; or not test -r "$pointer"
      echo 'Claude account selection is unreadable; choose an account again.' >&2; return 1
    end
    # Why read -z: it keeps newlines for the check below and exists before fish 3.4's collect flags.
    set -l profile ''
    if test -s "$pointer"; and not read -lz profile < "$pointer"
      echo 'Claude account selection is unreadable.' >&2; return 1
    end
    if string match -qr '[\\r\\n]' -- "$profile"
      echo 'Invalid Claude account selection.' >&2; return 1
    end
    if test -n "$profile"
      if not string match -qr '^(/|[A-Za-z]:[\\\\\\\\/])' -- "$profile"; or not test -d "$profile"
        echo 'Selected Claude profile is missing or invalid.' >&2; return 1
      end
      set -l headers
      if string match -irq '${authHeaderWords}' -- "$ANTHROPIC_CUSTOM_HEADERS"
        set headers -u ANTHROPIC_CUSTOM_HEADERS
      end
      env $headers -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CODE_OAUTH_TOKEN -u AWS_BEARER_TOKEN_BEDROCK CLAUDE_CONFIG_DIR="$profile" ORCA_CLAUDE_INJECTED_CONFIG_DIR="$profile" claude $argv
    else
      env -u CLAUDE_CONFIG_DIR -u ORCA_CLAUDE_INJECTED_CONFIG_DIR claude $argv
    end
  end
end
set -e __orca_claude_type
`
}

/** Leading newline: the codex fragment it follows ends without one. */
export function getPowerShellClaudeShellFunction(): string {
  if (!claudeProfileRoutingEnabled()) {
    return ''
  }
  return `
$orcaClaudeCommand = Get-Command claude -ErrorAction SilentlyContinue | Select-Object -First 1
if ($env:ORCA_CLAUDE_PROFILE_POINTER -and $orcaClaudeCommand -and
    $orcaClaudeCommand.CommandType -in @("Application", "ExternalScript")) {
function Global:claude {
    $saved = @{}
    $names = @('CLAUDE_CONFIG_DIR', 'ORCA_CLAUDE_INJECTED_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK', 'ANTHROPIC_CUSTOM_HEADERS')
    foreach ($name in $names) { $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
    try {
        if (-not $env:CLAUDE_CONFIG_DIR -or $env:CLAUDE_CONFIG_DIR -eq $env:ORCA_CLAUDE_INJECTED_CONFIG_DIR) {
            if (-not $env:ORCA_CLAUDE_PROFILE_POINTER) { throw 'Claude account selection is unreadable.' }
            $orcaClaudeHome = [IO.File]::ReadAllText($env:ORCA_CLAUDE_PROFILE_POINTER)
            if ($orcaClaudeHome) {
                if ($orcaClaudeHome -match '[\\r\\n\\x00]' -or -not [IO.Path]::IsPathRooted($orcaClaudeHome) -or -not [IO.Directory]::Exists($orcaClaudeHome)) { throw 'Selected Claude profile is missing or invalid.' }
                foreach ($name in $names) {
                    if ($name -ne 'ANTHROPIC_CUSTOM_HEADERS' -or $env:ANTHROPIC_CUSTOM_HEADERS -match '${authHeaderWords}') { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
                }
                $env:CLAUDE_CONFIG_DIR = $orcaClaudeHome
                $env:ORCA_CLAUDE_INJECTED_CONFIG_DIR = $orcaClaudeHome
            } else { Remove-Item Env:CLAUDE_CONFIG_DIR, Env:ORCA_CLAUDE_INJECTED_CONFIG_DIR -ErrorAction SilentlyContinue }
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
