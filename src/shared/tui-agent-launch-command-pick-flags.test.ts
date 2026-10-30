import { tokenizeStartupCommand } from './tui-agent-startup-shell'
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
      expect(result.command).toBe(`codex '-c' 'disable_paste_burst=true' ${expectedArgs}`)
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

  it.each([
    ['claude', 'opus', '--model=haiku', "claude '--model=haiku'"],
    ['codex', 'gpt-5.5', '-mo3', "codex '-c' 'disable_paste_burst=true' '-mo3'"]
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
    expect(result.command).toBe(
      "codex '-c' 'disable_paste_burst=true' '-m' 'gpt-5.5' '-c' 'model_reasoning_effort=low'"
    )
    expect(result.appliedSessionOptions).toEqual({ model: 'gpt-5.5' })
  })
})

describe('a saved permission mode on terminals', () => {
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

it.each([false, true])(
  'keeps Claude effective settings and Restart literal with override=%s',
  (override) => {
    const raw = `--settings '{"language":"french"}' --settings '{"env":{"SAFE":"kept"}}' --add-dir docs`
    const result = launch({
      agentArgs: raw,
      sessionOptions: { fastMode: true },
      sessionOptionsOverrideAgentArgs: override
    })
    const parsed = tokenizeStartupCommand(result.command, 'posix')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) {
      throw new Error('invalid compiler result')
    }
    const settings = parsed.tokens
      .filter((_, index) => parsed.tokens[index - 1] === '--settings')
      .map((value) => JSON.parse(value))
    expect(settings).toEqual([
      { language: 'french' },
      { env: { SAFE: 'kept' }, ...(override ? { fastMode: true } : {}) }
    ])
    expect(result.appliedSessionOptions.fastMode).toBe(override ? true : undefined)
    const restart = tokenizeStartupCommand(result.resumeLaunch.agentCommand, 'posix')
    expect(restart.ok).toBe(true)
    if (!restart.ok) {
      throw new Error('invalid Restart')
    }
    const resumed = restart.tokens
      .filter((_, index) => restart.tokens[index - 1] === '--settings')
      .map((value) => JSON.parse(value))
    expect(resumed).toEqual(settings)
  }
)

it('never claims Fast applied over a literal settings file, including custom commands', () => {
  for (const override of [false, true]) {
    const result = launch({
      cmdOverrides: { claude: 'my-claude' },
      agentArgs: '--settings ./team.json',
      sessionOptions: { fastMode: true },
      sessionOptionsOverrideAgentArgs: override
    })
    expect(result.command).toBe("my-claude '--settings' './team.json'")
    expect(result.appliedSessionOptions.fastMode).toBeUndefined()
    expect(result.resumeLaunch.agentCommand).toBe(result.command)
  }
})

it('retains same-token-count Claude settings rewrites in projection and Restart', () => {
  const agentArgs = `--settings '{"language":"french","fastMode":true}'`
  const result = launch({
    agentArgs,
    sessionOptions: { fastMode: false },
    sessionOptionsOverrideAgentArgs: true
  })
  expect(result.command).toContain('"language":"french","fastMode":false')
  expect(result.resumeLaunch.agentArgs).toContain('"language":"french","fastMode":false')
  expect(result.appliedSessionOptions.fastMode).toBe(false)
  const conflict = resolveAgentLaunchCommand({
    agent: 'claude',
    platform: 'linux',
    shell: 'posix',
    cmdOverrides: { claude: 'my-claude --settings ./fixed.json' },
    agentArgs,
    sessionOptions: { fastMode: false },
    sessionOptionsOverrideAgentArgs: true
  })
  expect(conflict).toMatchObject({ ok: false, error: expect.stringContaining('conflicts') })
})
