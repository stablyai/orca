import { describe, expect, it } from 'vitest'
import { withoutClaudeRootBypass } from './claude-root-bypass-launch'

describe('withoutClaudeRootBypass', () => {
  it('removes only the switch Claude parses, keeping prompts and option values byte for byte', () => {
    expect(
      withoutClaudeRootBypass(
        "claude --plugin-dir '/tmp/view x' --dangerously-skip-permissions --model opus 'fix --dangerously-skip-permissions'",
        'claude',
        'posix'
      )
    ).toBe("claude --plugin-dir '/tmp/view x' --model opus 'fix --dangerously-skip-permissions'")
    expect(
      withoutClaudeRootBypass(
        'orca claude-teams --dangerously-skip-permissions',
        'claude-agent-teams',
        'posix'
      )
    ).toBe('orca claude-teams')
  })

  it('leaves commands without a removable switch alone', () => {
    for (const command of [
      'claude --model opus',
      'claude -- --dangerously-skip-permissions',
      'claude --append-system-prompt --dangerously-skip-permissions'
    ]) {
      expect(withoutClaudeRootBypass(command, 'claude', 'posix')).toBeNull()
    }
    expect(withoutClaudeRootBypass('codex --yolo', 'codex', 'posix')).toBeNull()
  })
})
