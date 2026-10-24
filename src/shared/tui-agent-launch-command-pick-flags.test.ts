import { describe, expect, it } from 'vitest'
import { resolveAgentLaunchCommand } from './tui-agent-launch-command'

function launch(args: Partial<Parameters<typeof resolveAgentLaunchCommand>[0]>) {
  const result = resolveAgentLaunchCommand({
    agent: 'claude',
    cmdOverrides: {},
    platform: 'linux',
    shell: 'posix',
    ...args
  })
  if (!result.ok) {
    throw new Error(result.error)
  }
  return result
}

describe('one copy of each chat-picked flag', () => {
  it('sends one -m for Codex with a pick and a configured -m', () => {
    const result = launch({
      agent: 'codex',
      sessionOptions: { model: 'gpt-5.5', effort: 'high' },
      agentArgs: '-m o3'
    })
    expect(result.command).toBe("codex '-m' 'o3'")
    expect(result.appliedSessionOptions).toEqual({})
  })

  it.each(['-c model=o3', '--config model=o3', '-c=model=o3', '-cmodel=o3', '--config=model=o3'])(
    'yields the picked Codex model and its effort to configured %s',
    (agentArgs) => {
      const result = launch({
        agent: 'codex',
        sessionOptions: { model: 'gpt-5.5', effort: 'high' },
        agentArgs
      })
      const expectedArgs = agentArgs
        .split(' ')
        .map((token) => `'${token}'`)
        .join(' ')
      expect(result.command).toBe(`codex ${expectedArgs}`)
      expect(result.appliedSessionOptions).toEqual({})
    }
  )

  it('treats spaced Codex config model and effort as raw pins or removes them when overridden', () => {
    const agentArgs = '-c " model = o3" -c " model_reasoning_effort = low" -c model_verbosity=low'
    const inputs = {
      agent: 'codex' as const,
      agentArgs,
      sessionOptions: { model: 'gpt-5.5', effort: 'high' }
    }
    expect(launch(inputs).appliedSessionOptions).toEqual({})
    const saved = launch({ ...inputs, sessionOptionsOverrideAgentArgs: true })
    expect(saved.appliedSessionOptions).toEqual(inputs.sessionOptions)
    expect(saved.resumeLaunch).toEqual({
      agentCommand: "codex '-c' 'model_verbosity=low'",
      agentArgs: "'-c' 'model_verbosity=low'"
    })
  })

  it('sends only the configured Grok model without the picked model effort', () => {
    const result = launch({
      agent: 'grok',
      sessionOptions: { model: 'grok-4.6', effort: 'xhigh' },
      agentArgs: '-m grok-4.5'
    })
    expect(result.command).toBe("grok '-m' 'grok-4.5'")
    expect(result.appliedSessionOptions).toEqual({})
  })

  it.each([
    ['claude', 'opus', '--model=haiku', "claude '--model=haiku'"],
    ['codex', 'gpt-5.5', '-mo3', "codex '-mo3'"]
  ] as const)(
    'sends one model flag for %s with a configured %s',
    (agent, model, agentArgs, command) => {
      const result = launch({ agent, sessionOptions: { model }, agentArgs })
      expect(result.command).toBe(command)
      expect(result.appliedSessionOptions).toEqual({})
    }
  )

  it('sends one --effort for Claude with a configured --effort', () => {
    const result = launch({
      sessionOptions: { model: 'opus', effort: 'xhigh' },
      agentArgs: '--effort low'
    })
    expect(result.command).toBe("claude '--model' 'opus' '--effort' 'low'")
    expect(result.appliedSessionOptions).toEqual({ model: 'opus' })
  })

  it('keeps the catalog default for options the configured args do not set', () => {
    const result = launch({ sessionOptions: { model: 'opus' }, agentArgs: '--add-dir x' })
    expect(result.command).toBe("claude '--model' 'opus' '--effort' 'high' '--add-dir' 'x'")
  })

  it.each(['posix', 'powershell', 'cmd'] as const)(
    'preserves picks when a Docker override has a memory flag on %s',
    (shell) => {
      const result = launch({
        agent: 'codex',
        shell,
        platform: shell === 'posix' ? 'linux' : 'win32',
        cmdOverrides: { codex: 'docker run --rm -m 4g agent-image codex' },
        sessionOptions: { model: 'gpt-5.5', effort: 'high' }
      })
      expect(result.appliedSessionOptions).toEqual({ model: 'gpt-5.5', effort: 'high' })
      expect(result.command).toContain('gpt-5.5')
      expect(result.command).toContain('model_reasoning_effort=high')
    }
  )

  it.each(['echo --model diagnostic && claude', "claude --append-system-prompt '--model'"])(
    'preserves picks when override tokens are not agent options: %s',
    (command) => {
      const result = launch({
        cmdOverrides: { claude: command },
        sessionOptions: { model: 'opus', effort: 'high' }
      })
      expect(result.command).toBe(`${command} '--model' 'opus' '--effort' 'high'`)
      expect(result.appliedSessionOptions).toEqual({ model: 'opus', effort: 'high' })
    }
  )

  it('preserves picks when configured arguments contain flags after --', () => {
    const result = launch({
      agentArgs: '-- --model haiku',
      sessionOptions: { model: 'opus', effort: 'high' }
    })
    expect(result.command).toBe("claude '--model' 'opus' '--effort' 'high' '--' '--model' 'haiku'")
    expect(result.appliedSessionOptions).toEqual({ model: 'opus', effort: 'high' })
  })

  it('checks configured args without parsing an unparseable command override', () => {
    const result = launch({
      agent: 'codex',
      cmdOverrides: { codex: "codex -c 'x" },
      sessionOptions: { model: 'gpt-5.5' },
      agentArgs: '-m o3'
    })
    expect(result.command).toBe("codex -c 'x '-m' 'o3'")
    expect(result.command).not.toContain('gpt-5.5')
  })

  it('sends the picked Codex model when the configured args set only the effort', () => {
    const result = launch({
      agent: 'codex',
      sessionOptions: { model: 'gpt-5.5', effort: 'high' },
      agentArgs: '-c model_reasoning_effort=low'
    })
    expect(result.command).toBe("codex '-m' 'gpt-5.5' '-c' 'model_reasoning_effort=low'")
    expect(result.appliedSessionOptions).toEqual({ model: 'gpt-5.5' })
  })
})

describe('a saved permission mode on terminals', () => {
  it.each([
    [
      'claude',
      'accept-edits',
      '--dangerously-skip-permissions',
      "'--permission-mode' 'acceptEdits'"
    ],
    [
      'claude',
      'ask',
      '--permission-mode auto --verbose',
      "'--verbose' '--permission-mode' 'default'"
    ],
    // A required value that looks like a permission flag, and a positional after one, both stay.
    [
      'claude',
      'ask',
      "--append-system-prompt '--dangerously-skip-permissions' --dangerously-skip-permissions hi",
      "'--append-system-prompt' '--dangerously-skip-permissions' 'hi' '--permission-mode' 'default'"
    ],
    [
      'claude',
      'ask',
      '-- --dangerously-skip-permissions',
      "'--permission-mode' 'default' '--' '--dangerously-skip-permissions'"
    ],
    [
      'codex',
      'ask',
      '-a never -s danger-full-access --yolo --not-so-yolo -c " approvals_reviewer = auto_review" -c "default_permissions = workspace" -c model_verbosity=low',
      `'-c' 'model_verbosity=low' '-a' 'on-request' '-s' 'read-only' '-c' 'approvals_reviewer="user"'`
    ],
    ['codex', 'auto', '--dangerously-bypass-approvals-and-sandbox', "'--approve-for-me'"],
    [
      'codex',
      'full-access',
      '-a never -c sandbox_mode=read-only',
      "'--dangerously-bypass-approvals-and-sandbox'"
    ],
    [
      'grok',
      'ask',
      '--permission-mode bypassPermissions --always-approve --yolo --dangerously-skip-permissions',
      "'--permission-mode' 'default'"
    ],
    // No terminal flag for these modes: the raw arguments stay exactly as they were.
    ['antigravity', 'ask', '--dangerously-skip-permissions', "'--dangerously-skip-permissions'"],
    [
      'antigravity',
      'accept-edits',
      '--dangerously-skip-permissions',
      "'--dangerously-skip-permissions'"
    ],
    ['opencode', 'full-access', '--print-logs', "'--print-logs'"]
  ] as const)('%s %s replaces %s', (agent, permissionMode, agentArgs, expectedArgs) => {
    const plain = launch({ agent, agentArgs: '' }).command
    const result = launch({
      agent,
      agentArgs,
      sessionOptions: { permissionMode },
      sessionOptionsOverrideAgentArgs: true
    })
    expect(result.command).toBe(expectedArgs ? `${plain} ${expectedArgs}` : plain)
  })

  it('yields to a permission flag the caller keeps', () => {
    const result = launch({
      agent: 'claude',
      agentArgs: '--dangerously-skip-permissions',
      sessionOptions: { permissionMode: 'ask' }
    })
    expect(result.command).toBe("claude '--dangerously-skip-permissions'")
    expect(result.appliedSessionOptions).toEqual({})
  })
})
