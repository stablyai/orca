import { expect, it } from 'vitest'
import { withClaudeAgentViewPlugin } from './claude-agent-view-launch'
import { tokenizeStartupCommand, type AgentStartupShell } from './tui-agent-startup-shell'

it.each(['posix', 'powershell', 'cmd'] as const)(
  'preserves existing plugin arguments and prompts in %s',
  (shell: AgentStartupShell) => {
    const command = 'claude --plugin-dir user-plugin --resume session -- "my prompt"'
    const result = withClaudeAgentViewPlugin(command, 'orca plugin', shell)
    const parsed = tokenizeStartupCommand(result, shell)
    expect(parsed.ok && parsed.tokens).toEqual([
      'claude',
      '--plugin-dir',
      'orca plugin',
      '--plugin-dir',
      'user-plugin',
      '--resume',
      'session',
      '--',
      'my prompt'
    ])
  }
)

it.each(['ssh host claude', 'bash -c claude', 'echo /bin/claude', 'claude && echo done'])(
  'leaves shell syntax and ambiguous executables unchanged: %s',
  (command) => {
    expect(withClaudeAgentViewPlugin(command, '/orca/plugin', 'posix')).toBe(command)
  }
)
