import { claudeProfileRoutingEnabled } from './claude-profile-routing'
const authHeaderWords = 'authorization|x-api-key|api-key|bearer'
const posixAuthHeaderPattern = authHeaderWords
  .split('|')
  .map((word) => `*${word.replace(/[a-z]/g, (letter) => `[${letter}${letter.toUpperCase()}]`)}*`)
  .join('|')
const OVERRIDE_NOTE =
  'Orca: CLAUDE_CONFIG_DIR is set in this shell, so the Claude account selected in Orca is not used here.'
const MISSING_NOTE =
  "Orca: the selected Claude account's folder is missing. Sign in to it again or choose another account."

/**
 * `claude` re-reads the which-account file on every launch, so a switch reaches open terminals
 * (superset's wrapper rule). Defined only in a pane Orca routed (pointer env set) where `claude` is
 * a real executable. A missing or empty file is System default; a CLAUDE_CONFIG_DIR the user set,
 * as opposed to Orca's twin-marked value, wins.
 */
export function getPosixClaudeShellFunction(): string {
  if (!claudeProfileRoutingEnabled()) {
    return ''
  }
  return `__orca_claude_binary="$(unalias claude 2>/dev/null || :; command -v claude 2>/dev/null || :)"
if [[ -n "\${ORCA_CLAUDE_PROFILE_POINTER:-}" && -n "\${__orca_claude_binary:-}" && -x "\${__orca_claude_binary}" ]]; then
  function claude {
    local __orca_claude_home __orca_claude_pointer="\${ORCA_CLAUDE_PROFILE_POINTER:-}"
    # Why: a WSL pane's pointer is relative to the guest home, which the host cannot know at spawn.
    case "$__orca_claude_pointer" in '~/'*) __orca_claude_pointer="\${HOME:-}/\${__orca_claude_pointer#??}" ;; esac
    __orca_claude_home="$(cat "$__orca_claude_pointer" 2>/dev/null || :)"
    if [ -n "\${CLAUDE_CONFIG_DIR:-}" ] && [ "$CLAUDE_CONFIG_DIR" != "\${ORCA_CLAUDE_INJECTED_CONFIG_DIR:-}" ]; then
      [ -z "$__orca_claude_home" ] || [ "$__orca_claude_home" = "$CLAUDE_CONFIG_DIR" ] || printf '%s\\n' '${OVERRIDE_NOTE}' >&2
      command claude "$@"; return
    fi
    if [ -z "$__orca_claude_home" ]; then
      ( unset CLAUDE_CONFIG_DIR ORCA_CLAUDE_INJECTED_CONFIG_DIR; command claude "$@" ); return
    fi
    if [ ! -d "$__orca_claude_home" ]; then printf '%s\\n' "${MISSING_NOTE}" >&2; return 1; fi
    ( unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN AWS_BEARER_TOKEN_BEDROCK; case "\${ANTHROPIC_CUSTOM_HEADERS:-}" in ${posixAuthHeaderPattern}) unset ANTHROPIC_CUSTOM_HEADERS ;; esac; export CLAUDE_CONFIG_DIR="$__orca_claude_home" ORCA_CLAUDE_INJECTED_CONFIG_DIR="$__orca_claude_home"; command claude "$@" )
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
    # Why: a WSL pane's pointer is relative to the guest home, which the host cannot know at spawn.
    set -l pointer (string replace -r '^~/' "$HOME/" -- "$ORCA_CLAUDE_PROFILE_POINTER")
    set -l profile (cat "$pointer" 2>/dev/null)
    if test -n "$CLAUDE_CONFIG_DIR"; and test "$CLAUDE_CONFIG_DIR" != "$ORCA_CLAUDE_INJECTED_CONFIG_DIR"
      if test -n "$profile"; and test "$profile" != "$CLAUDE_CONFIG_DIR"
        echo '${OVERRIDE_NOTE}' >&2
      end
      command claude $argv
      return $status
    end
    if test -z "$profile"
      env -u CLAUDE_CONFIG_DIR -u ORCA_CLAUDE_INJECTED_CONFIG_DIR claude $argv
      return $status
    end
    if not test -d "$profile"
      echo "${MISSING_NOTE}" >&2; return 1
    end
    set -l headers
    if string match -irq '${authHeaderWords}' -- "$ANTHROPIC_CUSTOM_HEADERS"
      set headers -u ANTHROPIC_CUSTOM_HEADERS
    end
    env $headers -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CODE_OAUTH_TOKEN -u AWS_BEARER_TOKEN_BEDROCK CLAUDE_CONFIG_DIR="$profile" ORCA_CLAUDE_INJECTED_CONFIG_DIR="$profile" claude $argv
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
    $names = @('CLAUDE_CONFIG_DIR', 'ORCA_CLAUDE_INJECTED_CONFIG_DIR', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'AWS_BEARER_TOKEN_BEDROCK', 'ANTHROPIC_CUSTOM_HEADERS')
    $saved = @{}
    foreach ($name in $names) { $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
    try {
        $orcaClaudeHome = ''
        if ($env:ORCA_CLAUDE_PROFILE_POINTER -and (Test-Path -LiteralPath $env:ORCA_CLAUDE_PROFILE_POINTER -PathType Leaf)) {
            $orcaClaudeHome = [IO.File]::ReadAllText($env:ORCA_CLAUDE_PROFILE_POINTER).TrimEnd()
        }
        if ($env:CLAUDE_CONFIG_DIR -and $env:CLAUDE_CONFIG_DIR -ne $env:ORCA_CLAUDE_INJECTED_CONFIG_DIR) {
            if ($orcaClaudeHome -and $orcaClaudeHome -ne $env:CLAUDE_CONFIG_DIR) { [Console]::Error.WriteLine('${OVERRIDE_NOTE}') }
        } elseif (-not $orcaClaudeHome) {
            Remove-Item Env:CLAUDE_CONFIG_DIR, Env:ORCA_CLAUDE_INJECTED_CONFIG_DIR -ErrorAction SilentlyContinue
        } elseif (-not [IO.Directory]::Exists($orcaClaudeHome)) {
            throw "${MISSING_NOTE}"
        } else {
            foreach ($name in $names) {
                if ($name -ne 'ANTHROPIC_CUSTOM_HEADERS' -or $env:ANTHROPIC_CUSTOM_HEADERS -match '${authHeaderWords}') { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
            }
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
