import {
  ORCA_IMAGE_PROTOCOL_ENV,
  ORCA_IMAGE_PROTOCOL_VALUE
} from '../../../terminal/images/terminal-image-protocol'

function posixClaudeAccountRouting(
  run: string,
  runScoped: (setup: string) => string,
  fail: 'return' | 'exit'
): string {
  return [
    '__orca_claude_pointer="${ORCA_CLAUDE_PROFILE_POINTER:-}"',
    `if [ -z "$__orca_claude_pointer" ]; then ${run}; fi`,
    // A WSL pane's pointer can be relative to the guest home.
    'case "$__orca_claude_pointer" in \'~/\'*) __orca_claude_pointer="${HOME:-}/${__orca_claude_pointer#??}" ;; esac',
    '__orca_claude_home="$(cat "$__orca_claude_pointer" 2>/dev/null || :)"',
    'if [ -n "${CLAUDE_CONFIG_DIR:-}" ] && [ "$CLAUDE_CONFIG_DIR" != "${ORCA_CLAUDE_INJECTED_CONFIG_DIR:-}" ] && ' +
      '{ [ -z "${ORCA_CLAUDE_USER_CONFIG_DIR:-}" ] || [ "${CLAUDE_CONFIG_DIR%/}" != "${ORCA_CLAUDE_USER_CONFIG_DIR%/}" ]; }; ' +
      `then ${run}; fi`,
    // System default restores the config that Orca replaced at spawn.
    `if [ -z "$__orca_claude_home" ] && [ -n "\${CLAUDE_CONFIG_DIR:-}" ] && [ -n "\${ORCA_CLAUDE_USER_CONFIG_DIR:-}" ]; then ${runScoped(
      'unset ORCA_CLAUDE_INJECTED_CONFIG_DIR; export CLAUDE_CONFIG_DIR="$ORCA_CLAUDE_USER_CONFIG_DIR"'
    )}; fi`,
    `if [ -z "$__orca_claude_home" ]; then ${runScoped('unset CLAUDE_CONFIG_DIR ORCA_CLAUDE_INJECTED_CONFIG_DIR')}; fi`,
    `case "$__orca_claude_home" in /*|[A-Za-z]:*) ;; *) ${fail} 1 ;; esac`,
    '[ -d "$__orca_claude_home" ] || mkdir -p -m 700 -- "$__orca_claude_home" 2>/dev/null',
    runScoped(
      'export CLAUDE_CONFIG_DIR="$__orca_claude_home" ORCA_CLAUDE_INJECTED_CONFIG_DIR="$__orca_claude_home"'
    )
  ].join('; ')
}

export function getPosixClaudeDirectLaunchScript(): string {
  const run = 'exec "$__orca_claude_program" "$@"'
  return `__orca_claude_program=$1; shift; ${posixClaudeAccountRouting(run, (setup) => `${setup}; ${run}`, 'exit')}`
}

/** Re-read account selection on every launch in Orca-routed panes with a real claude binary. Missing/empty pointer restores the user’s config; another pane override wins. Create account homes without a login silently and preserve Anthropic auth. Refuse nonabsolute pointers rather than run under the wrong account. */
export function getPosixClaudeShellFunction(): string {
  // zsh exec can run functions, so remove the wrapper inside the subshell first.
  const routing = posixClaudeAccountRouting(
    'command claude "$@"; return',
    (setup) => `( ${setup}; unset -f claude; exec claude "$@" ); return`,
    'return'
  )
  return `__orca_claude_binary="$(unalias claude 2>/dev/null || :; command -v claude 2>/dev/null || :)"
# Why typeset -f: a user's own claude function wins; command -v prints its bare name, which -x tests against the cwd.
if ! typeset -f claude >/dev/null 2>&1 && [[ -n "\${__orca_claude_binary:-}" && -x "\${__orca_claude_binary}" ]] &&
   [[ -n "\${ORCA_CLAUDE_PROFILE_POINTER:-}" || "\${${ORCA_IMAGE_PROTOCOL_ENV}:-}" == '${ORCA_IMAGE_PROTOCOL_VALUE}' ]]; then
  function claude {
    local __orca_claude_home __orca_claude_pointer
    if [[ "\${${ORCA_IMAGE_PROTOCOL_ENV}:-}" == '${ORCA_IMAGE_PROTOCOL_VALUE}' && -z "\${CLAUDE_CODE_FORCE_TERMINAL_IMAGES+x}" ]]; then
      local -x CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1
    fi
    ${routing}
  }
fi
unset __orca_claude_binary
`
}

/** Leading newline separates the preceding codex fragment, which has no trailing newline. */
export function getFishClaudeShellFunction(): string {
  return `
set -l __orca_claude_type (type -t claude 2>/dev/null)
if test "$__orca_claude_type" = file; and begin; test -n "$ORCA_CLAUDE_PROFILE_POINTER"; or test "$${ORCA_IMAGE_PROTOCOL_ENV}" = '${ORCA_IMAGE_PROTOCOL_VALUE}'; end
  function claude
    test "$${ORCA_IMAGE_PROTOCOL_ENV}" = '${ORCA_IMAGE_PROTOCOL_VALUE}'; and not set -q CLAUDE_CODE_FORCE_TERMINAL_IMAGES; and set -lx CLAUDE_CODE_FORCE_TERMINAL_IMAGES 1
    if test -z "$ORCA_CLAUDE_PROFILE_POINTER"
      command claude $argv
      return $status
    end
    # Why: a WSL pane's pointer is relative to the guest home, which the host cannot know at spawn.
    set -l pointer (string replace -r '^~/' "$HOME/" -- "$ORCA_CLAUDE_PROFILE_POINTER")
    set -l profile (cat "$pointer" 2>/dev/null)
    set -l own (string trim -r -c / -- "$ORCA_CLAUDE_USER_CONFIG_DIR")
    set -l current (string trim -r -c / -- "$CLAUDE_CONFIG_DIR")
    if test -n "$CLAUDE_CONFIG_DIR"; and test "$CLAUDE_CONFIG_DIR" != "$ORCA_CLAUDE_INJECTED_CONFIG_DIR"; and begin; test -z "$own"; or test "$current" != "$own"; end
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

export function getPowerShellClaudeShellFunction(): string {
  return `$orcaClaudeCommand = Get-Command claude -ErrorAction SilentlyContinue | Select-Object -First 1
if (($env:ORCA_CLAUDE_PROFILE_POINTER -or $env:${ORCA_IMAGE_PROTOCOL_ENV} -ceq '${ORCA_IMAGE_PROTOCOL_VALUE}') -and $orcaClaudeCommand -and
    $orcaClaudeCommand.CommandType -in @("Application", "ExternalScript")) {
function Global:claude {
    ${powerShellSaveClaudeEnv(true)}
    try {
        if ($env:${ORCA_IMAGE_PROTOCOL_ENV} -ceq '${ORCA_IMAGE_PROTOCOL_VALUE}' -and -not (Test-Path Env:CLAUDE_CODE_FORCE_TERMINAL_IMAGES)) {
            $env:CLAUDE_CODE_FORCE_TERMINAL_IMAGES = '1'
        }
        ${powerShellClaudeAccountRouting}
        $binary = Get-Command claude -CommandType Application,ExternalScript -ErrorAction Stop | Select-Object -First 1
        $claudeArgs = @(__OrcaEscapeNativeArgs $binary.Source $args)
        if ($MyInvocation.ExpectingInput) { $input | & $binary.Source @claudeArgs } else { & $binary.Source @claudeArgs }
        $global:LASTEXITCODE = $LASTEXITCODE
    } catch { $global:LASTEXITCODE = 1; Write-Error $_ -ErrorAction Continue }
    finally { ${powerShellRestoreClaudeEnv} }
}
}
Remove-Variable orcaClaudeCommand -ErrorAction SilentlyContinue
`
}

function powerShellSaveClaudeEnv(images: boolean): string {
  const imageEnv = images ? ", 'CLAUDE_CODE_FORCE_TERMINAL_IMAGES'" : ''
  return (
    `$names = @('CLAUDE_CONFIG_DIR', 'ORCA_CLAUDE_INJECTED_CONFIG_DIR'${imageEnv}); $saved = @{}; ` +
    "foreach ($name in $names) { $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }"
  )
}

// On .NET 9+, SetEnvironmentVariable with a null value can leave an empty variable.
const powerShellRestoreClaudeEnv =
  'foreach ($name in $names) { ' +
  'if ($null -eq $saved[$name]) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue } ' +
  "else { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') } }"

const powerShellClaudeAccountRouting = [
  "$orcaClaudeHome = '';",
  'if ($env:ORCA_CLAUDE_PROFILE_POINTER -and (Test-Path -LiteralPath $env:ORCA_CLAUDE_PROFILE_POINTER -PathType Leaf)) {',
  '$orcaClaudeHome = [IO.File]::ReadAllText($env:ORCA_CLAUDE_PROFILE_POINTER).TrimEnd() };',
  // Windows names one folder with either separator.
  `$own = ("$env:ORCA_CLAUDE_USER_CONFIG_DIR" -replace '/', '\\').TrimEnd('\\');`,
  'if (-not $env:ORCA_CLAUDE_PROFILE_POINTER -or ($env:CLAUDE_CONFIG_DIR -and',
  '$env:CLAUDE_CONFIG_DIR -ne $env:ORCA_CLAUDE_INJECTED_CONFIG_DIR -and',
  `(-not $own -or ("$env:CLAUDE_CONFIG_DIR" -replace '/', '\\').TrimEnd('\\') -ne $own))) { }`,
  'elseif (-not $orcaClaudeHome) {',
  'Remove-Item Env:ORCA_CLAUDE_INJECTED_CONFIG_DIR -ErrorAction SilentlyContinue;',
  'if ($env:CLAUDE_CONFIG_DIR -and $env:ORCA_CLAUDE_USER_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR = $env:ORCA_CLAUDE_USER_CONFIG_DIR }',
  'else { Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue }',
  '} elseif (-not [IO.Path]::IsPathRooted($orcaClaudeHome)) { $global:LASTEXITCODE = 1; return }',
  'else {',
  'if (-not [IO.Directory]::Exists($orcaClaudeHome)) { $null = New-Item -ItemType Directory -Path $orcaClaudeHome -Force -ErrorAction SilentlyContinue };',
  '$env:CLAUDE_CONFIG_DIR = $orcaClaudeHome; $env:ORCA_CLAUDE_INJECTED_CONFIG_DIR = $orcaClaudeHome }'
].join(' ')

export function getPowerShellClaudeDirectLaunchScope(): { before: string; after: string } {
  return {
    before: `${powerShellSaveClaudeEnv(false)}; try { ${powerShellClaudeAccountRouting}; `,
    after: ` } finally { ${powerShellRestoreClaudeEnv} }`
  }
}
