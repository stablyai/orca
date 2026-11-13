import { TUI_AGENT_DISPLAY_NAMES } from '../../agent-launch/catalog/tui-agent-display-names'
import type { AgentSessionAccountKind } from '../agent-session-availability'
import {
  quoteStartupArg,
  type AgentStartupShell
} from '../../agent-launch/startup/tui-agent-startup-shell'

/** How a chat host installs and signs in each agent. `installCommand` is a POSIX shell line. */
export const AGENT_SESSION_SETUP_COMMANDS = [
  {
    agent: 'claude',
    loginCommand: ['claude', 'auth', 'login'],
    installCommand: 'curl -fsSL https://claude.ai/install.sh | bash'
  },
  // Why device auth from another device: these browser logins redirect to the host's localhost.
  {
    agent: 'codex',
    loginCommand: ['codex', 'login'],
    remoteLoginCommand: ['codex', 'login', '--device-auth'],
    installCommand: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh'
  },
  {
    agent: 'grok',
    loginCommand: ['grok', 'login'],
    remoteLoginCommand: ['grok', 'login', '--device-auth']
  },
  {
    agent: 'opencode',
    loginCommand: ['opencode', 'auth', 'login'],
    installCommand: 'curl -fsSL https://opencode.ai/install | bash'
  },
  { agent: 'opencode2', loginCommand: ['opencode2', 'auth', 'login'] },
  { agent: 'pi', loginCommand: ['pi'], slashCommand: '/login' },
  { agent: 'omp', loginCommand: ['omp'], slashCommand: '/login' },
  {
    agent: 'copilot',
    loginCommand: ['copilot', 'login'],
    remoteLoginCommand: ['copilot', 'login', '--device-code'],
    installCommand: 'curl -fsSL https://gh.io/copilot-install | bash'
  },
  // `kimi login` is already a device-code login.
  {
    agent: 'kimi',
    loginCommand: ['kimi', 'login'],
    installCommand: 'curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash'
  },
  {
    agent: 'cursor',
    loginCommand: ['cursor-agent', 'login'],
    installCommand: 'curl https://cursor.com/install -fsS | bash'
  },
  // An `agy` login does not sign its chats in: they keep their own sign-in.
  { agent: 'antigravity', loginCommand: [] }
] as const

export function agentSessionSetupFor(agent: string | undefined) {
  return AGENT_SESSION_SETUP_COMMANDS.find(
    (entry) => entry.agent === agent || TUI_AGENT_DISPLAY_NAMES[entry.agent] === agent
  )
}

/** The terminal command that signs `agent` in on its chat host; `remote` when the user watches from another device. */
export function agentSessionSignInCommand(
  agent: string | undefined,
  options: { account?: AgentSessionAccountKind; remote: boolean; shell?: AgentStartupShell | null }
): string | null {
  const entry = agentSessionSetupFor(agent)
  // Why: host terminals follow the selected managed Claude account; other managed logins aren't known to land.
  if (!entry || (options.account === 'managed' && entry.agent !== 'claude')) {
    return null
  }
  if (entry.agent === 'claude' && options.account === 'system') {
    return options.shell === null ? null : claudeSystemSignInCommand(options.shell ?? 'posix')
  }
  const argv =
    options.remote && 'remoteLoginCommand' in entry ? entry.remoteLoginCommand : entry.loginCommand
  // Why a plain join: every word is a bare token, which POSIX, PowerShell and cmd all read alike.
  return argv.length > 0 ? argv.join(' ') : null
}

/** Bypass the selected-profile function and restore the config Orca replaced for this login. */
function claudeSystemSignInCommand(shell: AgentStartupShell): string {
  if (shell === 'powershell') {
    return [
      "& { $names = @('CLAUDE_CONFIG_DIR', 'ORCA_CLAUDE_INJECTED_CONFIG_DIR', 'ORCA_CLAUDE_PROFILE_POINTER'); $saved = @{};",
      "foreach ($name in $names) { $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') };",
      'try { if ($env:ORCA_CLAUDE_INJECTED_CONFIG_DIR -and $env:CLAUDE_CONFIG_DIR -eq $env:ORCA_CLAUDE_INJECTED_CONFIG_DIR) {',
      'if ($env:ORCA_CLAUDE_USER_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR = $env:ORCA_CLAUDE_USER_CONFIG_DIR }',
      'else { Remove-Item Env:CLAUDE_CONFIG_DIR -ErrorAction SilentlyContinue } };',
      'Remove-Item Env:ORCA_CLAUDE_INJECTED_CONFIG_DIR, Env:ORCA_CLAUDE_PROFILE_POINTER -ErrorAction SilentlyContinue;',
      '& (Get-Command claude -CommandType Application,ExternalScript -ErrorAction Stop | Select-Object -First 1).Source auth login',
      '} finally { foreach ($name in $names) { if ($null -eq $saved[$name]) {',
      'Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue',
      "} else { [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process') } } } }"
    ].join(' ')
  }
  if (shell === 'cmd') {
    return 'if defined ORCA_CLAUDE_INJECTED_CONFIG_DIR if "%CLAUDE_CONFIG_DIR%"=="%ORCA_CLAUDE_INJECTED_CONFIG_DIR%" set "CLAUDE_CONFIG_DIR=%ORCA_CLAUDE_USER_CONFIG_DIR%" & set "ORCA_CLAUDE_INJECTED_CONFIG_DIR=" & set "ORCA_CLAUDE_PROFILE_POINTER=" & claude auth login'
  }
  const script =
    'if [ -n "${ORCA_CLAUDE_INJECTED_CONFIG_DIR:-}" ] && [ "${CLAUDE_CONFIG_DIR:-}" = "$ORCA_CLAUDE_INJECTED_CONFIG_DIR" ]; then ' +
    'if [ -n "${ORCA_CLAUDE_USER_CONFIG_DIR:-}" ]; then export CLAUDE_CONFIG_DIR="$ORCA_CLAUDE_USER_CONFIG_DIR"; else unset CLAUDE_CONFIG_DIR; fi; fi; ' +
    'unset ORCA_CLAUDE_INJECTED_CONFIG_DIR ORCA_CLAUDE_PROFILE_POINTER; exec claude auth login'
  return `sh -c ${quoteStartupArg(script, shell)}`
}

/** The shell line that installs `agent` on a host of `hostPlatform`; null when unknown, Windows, or without one. */
export function agentSessionInstallCommand(
  agent: string | undefined,
  hostPlatform: string | null | undefined
): string | null {
  const entry = agentSessionSetupFor(agent)
  return hostPlatform && hostPlatform !== 'win32' && entry && 'installCommand' in entry
    ? entry.installCommand
    : null
}
