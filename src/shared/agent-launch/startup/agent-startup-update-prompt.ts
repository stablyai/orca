import type { TuiAgent } from '../catalog/tui-agent'

// Why: Enter on Codex's "Update available" screen picks "Update now", which installs and exits.
export const STARTUP_UPDATE_PROMPT_SUPPRESSION_ARGS: Partial<Record<TuiAgent, readonly string[]>> =
  {
    codex: ['-c', 'check_for_update_on_startup=false'],
    aider: ['--no-check-update', '--no-show-release-notes'],
    cursor: ['--disable-auto-update']
  }

export const STARTUP_UPDATE_PROMPT_SUPPRESSION_ENV: Partial<
  Record<TuiAgent, Readonly<Record<string, string>>>
> = {
  claude: { DISABLE_AUTOUPDATER: '1' },
  'claude-agent-teams': { DISABLE_AUTOUPDATER: '1' },
  opencode: { OPENCODE_DISABLE_AUTOUPDATE: 'true' },
  opencode2: { OPENCODE_DISABLE_AUTOUPDATE: 'true' },
  antigravity: { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' },
  grok: { GROK_DISABLE_AUTOUPDATER: '1' },
  pi: { PI_SKIP_VERSION_CHECK: '1' },
  kimi: { KIMI_CODE_NO_AUTO_UPDATE: '1', KIMI_CLI_NO_AUTO_UPDATE: '1' }
}

/** What keeps an agent's update screen from taking the first Enter Orca sends; aider's flags must trail its args. */
export function startupUpdatePromptSuppression(agent: TuiAgent): {
  args: readonly string[]
  env?: Readonly<Record<string, string>>
} {
  return {
    args: agent === 'aider' ? [] : (STARTUP_UPDATE_PROMPT_SUPPRESSION_ARGS[agent] ?? []),
    env: STARTUP_UPDATE_PROMPT_SUPPRESSION_ENV[agent]
  }
}
