import { describe, expect, it } from 'vitest'
import { planClaudeRootLaunch, withoutClaudeRootBypass } from './claude-root-bypass-launch'

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

  it('leaves commands alone when removal is unsafe or would not stop the refusal', () => {
    for (const command of [
      'claude --model opus',
      'claude -- --dangerously-skip-permissions',
      'claude --append-system-prompt --dangerously-skip-permissions',
      // The prompt would become another --add-dir directory.
      'claude --add-dir /a --dangerously-skip-permissions fix',
      'claude --dangerously-skip-permissions --permission-mode bypassPermissions',
      'claude --dangerously-skip-permissions --allow-dangerously-skip-permissions',
      'IS_SANDBOX=1 claude --dangerously-skip-permissions',
      'CLAUDE_CODE_BUBBLEWRAP=1 claude --dangerously-skip-permissions',
      // A repeated switch must not hide the word the value option would take.
      'claude --add-dir /a --dangerously-skip-permissions --dangerously-skip-permissions fix',
      `claude --dangerously-skip-permissions --settings '{"permissions":{"defaultMode":"bypassPermissions"}}'`
    ]) {
      expect(withoutClaudeRootBypass(command, 'claude', 'posix')).toBeNull()
    }
    expect(withoutClaudeRootBypass('codex --yolo', 'codex', 'posix')).toBeNull()
  })
})

describe('planClaudeRootLaunch', () => {
  const command = 'claude --dangerously-skip-permissions'
  const plan = (isRoot: boolean, env: Record<string, string> = {}) =>
    planClaudeRootLaunch({ command, agent: 'claude', shell: 'posix', isRoot, env: [env] })

  it('downgrades only for root, and not when the user already declared a sandbox', () => {
    expect(plan(true)?.command).toBe('claude')
    expect(plan(false)).toBeNull()
    expect(plan(true, { IS_SANDBOX: '1' })).toBeNull()
    expect(plan(true, { CLAUDE_CODE_BUBBLEWRAP: '1' })).toBeNull()
  })
})
