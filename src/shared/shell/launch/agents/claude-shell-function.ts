import {
  ORCA_IMAGE_PROTOCOL_ENV,
  ORCA_IMAGE_PROTOCOL_VALUE
} from '../../../terminal/images/terminal-image-protocol'
import {
  CLAUDE_HOOK_PLUGIN_DIR_ENV,
  CLAUDE_MANAGED_HOOK_COMMAND_PATTERN
} from '../../../agent-hook-listener/providers/claude/claude-hook-plugin'

const posixClaudeImageCondition = `[ "\${${ORCA_IMAGE_PROTOCOL_ENV}:-}" = '${ORCA_IMAGE_PROTOCOL_VALUE}' ] && [ -z "\${CLAUDE_CODE_FORCE_TERMINAL_IMAGES+x}" ]`

// A custom config without Orca's hooks gets the plugin once.
const posixClaudeHookPlugin = /* @__PURE__ */ [
  '__orca_claude_hook_plugin() {',
  `__orca_plugin="\${${CLAUDE_HOOK_PLUGIN_DIR_ENV}:-}" __orca_sep=':'; __orca_claude_plugins=;`,
  '[ -n "$1" ] && [ "$1" != "${ORCA_CLAUDE_INJECTED_CONFIG_DIR:-}" ] && [ -n "$__orca_plugin" ] || return 0;',
  `case "$__orca_plugin" in [A-Za-z]:*) __orca_sep=';' ;; esac;`,
  'case "$__orca_sep${CLAUDE_CODE_PLUGIN_DIRS:-}$__orca_sep" in *"$__orca_sep$__orca_plugin$__orca_sep"*) return 0 ;; esac;',
  '[ -f "$__orca_plugin/hooks/hooks.json" ] || return 0;',
  `! grep -qsE '${CLAUDE_MANAGED_HOOK_COMMAND_PATTERN}' "$1/settings.json" || return 0;`,
  '__orca_claude_plugins="${CLAUDE_CODE_PLUGIN_DIRS:+$CLAUDE_CODE_PLUGIN_DIRS$__orca_sep}$__orca_plugin"; }'
].join(' ')

const posixClaudeHookEnv = '__orca_claude_hook_plugin "${CLAUDE_CONFIG_DIR:-}"'
const posixClaudeExportHooks = `${posixClaudeHookEnv}; [ -z "$__orca_claude_plugins" ] || export CLAUDE_CODE_PLUGIN_DIRS="$__orca_claude_plugins"`

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

export function getPosixClaudeDirectLaunchScript(
  execute = 'exec "$__orca_claude_program" "$@"'
): string {
  const run = `${posixClaudeExportHooks}; ${execute}`
  return `${posixClaudeHookPlugin}; __orca_claude_program=$1; shift; if ${posixClaudeImageCondition}; then export CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1; fi; ${posixClaudeAccountRouting(run, (setup) => `${setup}; ${run}`, 'exit')}`
}

/** Re-read account selection on every launch in Orca-routed panes with a real claude binary. Missing/empty pointer restores the user’s config; another pane override wins. Create account homes without a login silently and preserve Anthropic auth. Refuse nonabsolute pointers rather than run under the wrong account. */
export function getPosixClaudeShellFunction(): string {
  // zsh exec can run functions, so remove the wrapper inside the subshell first.
  const routing = posixClaudeAccountRouting(
    `${posixClaudeHookEnv}; if [ -n "$__orca_claude_plugins" ]; then local -x CLAUDE_CODE_PLUGIN_DIRS="$__orca_claude_plugins"; fi; command claude "$@"; return`,
    (setup) => `( ${setup}; ${posixClaudeExportHooks}; unset -f claude; exec claude "$@" ); return`,
    'return'
  )
  return `__orca_claude_binary="$(unalias claude 2>/dev/null || :; command -v claude 2>/dev/null || :)"
# Why typeset -f: a user's own claude function wins; command -v prints its bare name, which -x tests against the cwd.
if ! typeset -f claude >/dev/null 2>&1 && [[ -n "\${__orca_claude_binary:-}" && -x "\${__orca_claude_binary}" ]] &&
   [[ -n "\${ORCA_CLAUDE_PROFILE_POINTER:-}" || -n "\${${CLAUDE_HOOK_PLUGIN_DIR_ENV}:-}" || "\${${ORCA_IMAGE_PROTOCOL_ENV}:-}" == '${ORCA_IMAGE_PROTOCOL_VALUE}' ]]; then
  ${posixClaudeHookPlugin}
  function claude {
    local __orca_claude_home __orca_claude_pointer __orca_claude_plugins __orca_plugin __orca_sep
    if ${posixClaudeImageCondition}; then
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
if test "$__orca_claude_type" = file; and begin; test -n "$ORCA_CLAUDE_PROFILE_POINTER"; or test -n "$${CLAUDE_HOOK_PLUGIN_DIR_ENV}"; or test "$${ORCA_IMAGE_PROTOCOL_ENV}" = '${ORCA_IMAGE_PROTOCOL_VALUE}'; end
  # Why: a config folder Orca never hooked gets Orca's hooks from its plugin; one already carrying them would post twice.
  function __orca_claude_hook_plugin
    set -l plugin "$${CLAUDE_HOOK_PLUGIN_DIR_ENV}"
    test -n "$argv[1]"; and test "$argv[1]" != "$ORCA_CLAUDE_INJECTED_CONFIG_DIR"; and test -n "$plugin"; or return 0
    set -l sep ':'
    string match -qr '^[A-Za-z]:' -- "$plugin"; and set sep ';'
    contains -- "$plugin" (string split -- $sep "$CLAUDE_CODE_PLUGIN_DIRS"); and return 0
    test -f "$plugin/hooks/hooks.json"; or return 0
    test -f "$argv[1]/settings.json"; and string match -qr -- '${CLAUDE_MANAGED_HOOK_COMMAND_PATTERN}' < "$argv[1]/settings.json"; and return 0
    if test -n "$CLAUDE_CODE_PLUGIN_DIRS"; echo "$CLAUDE_CODE_PLUGIN_DIRS$sep$plugin"; else; echo "$plugin"; end
  end
  function claude
    test "$${ORCA_IMAGE_PROTOCOL_ENV}" = '${ORCA_IMAGE_PROTOCOL_VALUE}'; and not set -q CLAUDE_CODE_FORCE_TERMINAL_IMAGES; and set -lx CLAUDE_CODE_FORCE_TERMINAL_IMAGES 1
    if test -z "$ORCA_CLAUDE_PROFILE_POINTER"
      set -l plugins (__orca_claude_hook_plugin "$CLAUDE_CONFIG_DIR")
      test -n "$plugins"; and set -lx CLAUDE_CODE_PLUGIN_DIRS "$plugins"
      command claude $argv
      return $status
    end
    # Why: a WSL pane's pointer is relative to the guest home, which the host cannot know at spawn.
    set -l pointer (string replace -r '^~/' "$HOME/" -- "$ORCA_CLAUDE_PROFILE_POINTER")
    set -l profile (cat "$pointer" 2>/dev/null)
    set -l own (string trim -r -c / -- "$ORCA_CLAUDE_USER_CONFIG_DIR")
    set -l current (string trim -r -c / -- "$CLAUDE_CONFIG_DIR")
    if test -n "$CLAUDE_CONFIG_DIR"; and test "$CLAUDE_CONFIG_DIR" != "$ORCA_CLAUDE_INJECTED_CONFIG_DIR"; and begin; test -z "$own"; or test "$current" != "$own"; end
      set -l plugins (__orca_claude_hook_plugin "$CLAUDE_CONFIG_DIR")
      test -n "$plugins"; and set -lx CLAUDE_CODE_PLUGIN_DIRS "$plugins"
      command claude $argv
      return $status
    end
    # Why command env: a user env function (e.g. grc's) pipes stdout, so Claude would start in --print mode.
    if test -z "$profile"; and test -n "$CLAUDE_CONFIG_DIR"; and test -n "$ORCA_CLAUDE_USER_CONFIG_DIR"
      set -l plugins (__orca_claude_hook_plugin "$ORCA_CLAUDE_USER_CONFIG_DIR")
      test -n "$plugins"; and set -lx CLAUDE_CODE_PLUGIN_DIRS "$plugins"
      command env -u ORCA_CLAUDE_INJECTED_CONFIG_DIR CLAUDE_CONFIG_DIR="$ORCA_CLAUDE_USER_CONFIG_DIR" claude $argv
      return $status
    end
    if test -z "$profile"
      command env -u CLAUDE_CONFIG_DIR -u ORCA_CLAUDE_INJECTED_CONFIG_DIR claude $argv
      return $status
    end
    if not string match -qr '^(/|[A-Za-z]:)' -- "$profile"
      return 1
    end
    test -d "$profile"; or mkdir -p -m 700 -- "$profile" 2>/dev/null
    command env CLAUDE_CONFIG_DIR="$profile" ORCA_CLAUDE_INJECTED_CONFIG_DIR="$profile" claude $argv
  end
end
set -e __orca_claude_type
`
}

const powerShellClaudeImageSetup = `if ($env:${ORCA_IMAGE_PROTOCOL_ENV} -ceq '${ORCA_IMAGE_PROTOCOL_VALUE}' -and -not (Test-Path Env:CLAUDE_CODE_FORCE_TERMINAL_IMAGES)) { $env:CLAUDE_CODE_FORCE_TERMINAL_IMAGES = '1' }`

export function getPowerShellClaudeShellFunction(): string {
  return `$orcaClaudeCommand = Get-Command claude -ErrorAction SilentlyContinue | Select-Object -First 1
if (($env:ORCA_CLAUDE_PROFILE_POINTER -or $env:${CLAUDE_HOOK_PLUGIN_DIR_ENV} -or $env:${ORCA_IMAGE_PROTOCOL_ENV} -ceq '${ORCA_IMAGE_PROTOCOL_VALUE}') -and $orcaClaudeCommand -and
    $orcaClaudeCommand.CommandType -in @("Application", "ExternalScript")) {
function Global:claude {
    ${powerShellSaveClaudeEnv}
    try {
        ${powerShellClaudeImageSetup}
        ${powerShellClaudeAccountRouting}
        ${powerShellClaudeHookPlugin}
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

const powerShellSaveClaudeEnv =
  "$names = @('CLAUDE_CONFIG_DIR', 'ORCA_CLAUDE_INJECTED_CONFIG_DIR', 'CLAUDE_CODE_FORCE_TERMINAL_IMAGES', 'CLAUDE_CODE_PLUGIN_DIRS'); $saved = @{}; " +
  "foreach ($name in $names) { $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }"

const powerShellClaudeHookPlugin = /* @__PURE__ */ [
  `$orcaPlugin = $env:${CLAUDE_HOOK_PLUGIN_DIR_ENV};`,
  '$orcaConfig = $env:CLAUDE_CONFIG_DIR; $sep = [IO.Path]::PathSeparator;',
  '$plugins = @("$env:CLAUDE_CODE_PLUGIN_DIRS".Split($sep) | Where-Object { $_ });',
  'if ($orcaPlugin -and $orcaConfig -and $orcaConfig -ne $env:ORCA_CLAUDE_INJECTED_CONFIG_DIR -and $plugins -notcontains $orcaPlugin -and',
  "(Test-Path -LiteralPath (Join-Path $orcaPlugin 'hooks/hooks.json') -PathType Leaf) -and",
  `-not (Select-String -Quiet -Pattern '${CLAUDE_MANAGED_HOOK_COMMAND_PATTERN}' -LiteralPath (Join-Path $orcaConfig 'settings.json') -ErrorAction SilentlyContinue)) {`,
  '$env:CLAUDE_CODE_PLUGIN_DIRS = (@($plugins) + $orcaPlugin) -join $sep }'
].join(' ')

// On .NET 9+, SetEnvironmentVariable with a null value can leave an empty variable.
const powerShellRestoreClaudeEnv =
  'foreach ($name in $names) { ' +
  'if ($null -eq $saved[$name]) { Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue } ' +
  "else { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') } }"

const powerShellClaudeAccountRouting = /* @__PURE__ */ [
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
    before: `${powerShellSaveClaudeEnv}; try { ${powerShellClaudeImageSetup}; ${powerShellClaudeAccountRouting}; ${powerShellClaudeHookPlugin}; `,
    after: ` } finally { ${powerShellRestoreClaudeEnv} }`
  }
}
