import { describe, expect, it } from 'vitest'
import { mergeExtraAgentArgs, parseExtraAgentArgs } from './automation-extra-agent-args'
import { buildAgentStartupPlan } from './tui-agent-startup'
import { tokenizeStartupCommand, type AgentStartupShell } from './tui-agent-startup-shell'
import type { TuiAgent } from './tui-agent'

function merged(
  agent: TuiAgent,
  defaultArgs: string,
  extraAgentArgs: string,
  shell: AgentStartupShell = 'posix'
): string[] {
  const result = mergeExtraAgentArgs({ agent, defaultArgs, extraAgentArgs, shell })
  if (!result.ok) {
    throw new Error(result.error)
  }
  const tokens = tokenizeStartupCommand(result.agentArgs, shell)
  if (!tokens.ok) {
    throw new Error(tokens.error)
  }
  return tokens.tokens
}

function rejection(agent: TuiAgent, extraAgentArgs: string) {
  const result = parseExtraAgentArgs({ agent, extraAgentArgs })
  return result.ok ? null : result.error
}

describe('mergeExtraAgentArgs', () => {
  it('matches the documented example', () => {
    expect(
      merged(
        'claude',
        '--dangerously-skip-permissions --model sonnet --add-dir docs',
        '--model opus --add-dir tests'
      )
    ).toEqual([
      '--dangerously-skip-permissions',
      '--add-dir',
      'docs',
      '--model',
      'opus',
      '--add-dir',
      'tests'
    ])
  })

  it('returns defaults unchanged without extras', () => {
    for (const extras of ['', '   ']) {
      expect(
        mergeExtraAgentArgs({
          agent: 'claude',
          defaultArgs: '--model "a b"',
          extraAgentArgs: extras,
          shell: 'posix'
        })
      ).toEqual({ ok: true, agentArgs: '--model "a b"' })
    }
  })

  it.each([
    ['claude', '--model sonnet --effort low', '--model=opus', ['--effort', 'low', '--model=opus']],
    [
      'claude',
      '--model sonnet --effort low',
      '--effort high',
      ['--model', 'sonnet', '--effort', 'high']
    ],
    ['claude', '--model=sonnet --effort=low', '--effort=max', ['--model=sonnet', '--effort=max']],
    [
      'codex',
      '--dangerously-bypass-approvals-and-sandbox -m gpt-5.5 -c model_reasoning_effort=low',
      '--model=gpt-5.6-sol',
      [
        '--dangerously-bypass-approvals-and-sandbox',
        '-c',
        'model_reasoning_effort=low',
        '--model=gpt-5.6-sol'
      ]
    ],
    [
      'codex',
      '-m gpt-5.5 --config=model_reasoning_effort=low -c model="x"',
      '-c model_reasoning_effort=high',
      ['-m', 'gpt-5.5', '-c', 'model=x', '-c', 'model_reasoning_effort=high']
    ],
    ['codex', '-m gpt-5.5', '-mgpt-5.6-luna', ['-mgpt-5.6-luna']],
    [
      'codebuddy',
      '--dangerously-skip-permissions --model fast-model --effort low',
      '--effort xhigh',
      ['--dangerously-skip-permissions', '--model', 'fast-model', '--effort', 'xhigh']
    ],
    [
      'cursor',
      '--yolo -m auto',
      '--model gpt-5.3-codex-high',
      ['--yolo', '--model', 'gpt-5.3-codex-high']
    ],
    [
      'grok',
      '--permission-mode bypassPermissions -m grok-4.6 --effort low',
      '--reasoning-effort high',
      ['--permission-mode', 'bypassPermissions', '-m', 'grok-4.6', '--reasoning-effort', 'high']
    ],
    [
      'grok',
      '-m grok-4.6 --reasoning-effort low',
      '--model=grok-4.7',
      ['--reasoning-effort', 'low', '--model=grok-4.7']
    ],
    ['omp', '--model a/b', '--model c/d', ['--model', 'c/d']]
  ] as const)('%s: %s + %s', (agent, defaults, extras, expected) => {
    expect(merged(agent, defaults, extras)).toEqual(expected)
  })

  it('keeps flag-like values of other default options', () => {
    expect(
      merged('claude', '--append-system-prompt "--model=haiku" --model sonnet', '--model opus')
    ).toEqual(['--append-system-prompt', '--model=haiku', '--model', 'opus'])
  })

  it('inserts extras before a default terminator', () => {
    expect(merged('claude', '--model sonnet -- trailing', '--add-dir x')).toEqual([
      '--model',
      'sonnet',
      '--add-dir',
      'x',
      '--',
      'trailing'
    ])
  })

  it('reports an invalid extra rather than merging', () => {
    expect(
      mergeExtraAgentArgs({
        agent: 'claude',
        defaultArgs: '',
        extraAgentArgs: '--print',
        shell: 'posix'
      })
    ).toMatchObject({ ok: false, error: expect.stringContaining('"--print"') })
  })
})

describe('parseExtraAgentArgs rejections', () => {
  it.each([
    ['claude', 'bad\u0007', 'control characters'],
    ['claude', '--model\u2028opus', 'control characters'],
    ['claude', '--model "opus', 'Unclosed quote'],
    ['claude', '--model opus; rm -rf /', 'shell syntax'],
    ['claude', '--model $(whoami)', 'shell syntax'],
    ['claude', '--model opus --', '"--"'],
    ['claude', 'mcp list', '"mcp" isn\'t an option'],
    ['claude', '--model opus extra', '"extra" isn\'t an option'],
    ['claude', '--dangerously-skip-permissions', '"--dangerously-skip-permissions"'],
    ['claude', '--permission-mode=bypassPermissions', '"--permission-mode"'],
    ['claude', '--resume abc', '"--resume"'],
    ['claude', '-p', '"-p"'],
    ['claude', '--settings x.json', '"--settings"'],
    ['claude', '--mcp-config x.json', '"--mcp-config"'],
    ['claude', '--system-prompt hi', '"--system-prompt"'],
    ['claude', '--plugin-dir x', '"--plugin-dir"'],
    ['claude', '--model', 'needs a value'],
    ['claude', '--model=', 'needs a value'],
    ['claude', '--model --effort high', 'needs a value'],
    ['claude', '--model opus --model=haiku', 'model more than once'],
    ['claude', '--effort low --effort=high', 'effort more than once'],
    ['codex', '-c sandbox_mode=danger-full-access', 'model_reasoning_effort'],
    ['codex', '--config=approval_policy=never', 'model_reasoning_effort'],
    ['codex', '-c model_reasoning_effort=', 'model_reasoning_effort'],
    ['codex', '-c model=gpt-5', 'model_reasoning_effort'],
    ['codex', '--sandbox danger-full-access', '"--sandbox"'],
    ['codex', '--add-dir x', '"--add-dir"'],
    ['codex', '-m a -c model_reasoning_effort=low --model b', 'model more than once'],
    ['codex', 'exec', '"exec" isn\'t an option'],
    ['cursor', '--yolo', '"--yolo"'],
    ['cursor', '--effort high', '"--effort"'],
    ['grok', '--effort low --reasoning-effort high', 'effort more than once'],
    ['grok', '--permission-mode bypassPermissions', '"--permission-mode"'],
    ['omp', '--effort high', '"--effort"'],
    ['codebuddy', '--add-dir x', '"--add-dir"']
  ] as const)('%s rejects %j', (agent, extras, message) => {
    expect(rejection(agent, extras)).toContain(message)
  })

  it('limits extras to 4 KiB', () => {
    expect(rejection('claude', `--add-dir ${'é'.repeat(2100)}`)).toContain('4 KB')
  })

  it('refuses agents without modeled options', () => {
    expect(rejection('gemini', '-m gemini-2.5-pro')).toContain("aren't supported")
  })

  it('accepts repeatable options', () => {
    expect(rejection('claude', '--add-dir a --add-dir=b --model opus --effort high')).toBeNull()
  })
})

// Saved text uses one grammar; each execution shell must preserve the resulting argv.
const ROUND_TRIP_FIXTURES: Record<AgentStartupShell, readonly (readonly [string, string])[]> = {
  posix: [
    ["'docs/my specs'", 'docs/my specs'],
    ["'a$b'", 'a$b'],
    ["'tick`tock'", 'tick`tock'],
    ["'%PATH%'", '%PATH%'],
    ['"it\'s"', "it's"],
    ["'C:\\dir\\'", 'C:\\dir\\'],
    ["'日本語 🚀'", '日本語 🚀']
  ],
  powershell: [
    ["'docs/my specs'", 'docs/my specs'],
    ["'a$b'", 'a$b'],
    ["'%PATH%'", '%PATH%'],
    ['"it\'s"', "it's"],
    ["'C:\\dir\\'", 'C:\\dir\\'],
    ["'日本語 🚀'", '日本語 🚀']
  ],
  cmd: [
    ['"docs/my specs"', 'docs/my specs'],
    ['"a$b"', 'a$b'],
    ["'tick`tock'", 'tick`tock'],
    ['"%PATH%"', '%PATH%'],
    ['"it\'s"', "it's"],
    ["'C:\\dir'", 'C:\\dir'],
    ['"日本語 🚀"', '日本語 🚀']
  ]
}

describe.each(['posix', 'powershell', 'cmd'] as const)('round trip on %s', (shell) => {
  it('uses the same saved quoting for every execution shell', () => {
    expect(merged('claude', '', "--add-dir 'C:\\work\\my docs' --model opus", shell)).toEqual([
      '--add-dir',
      'C:\\work\\my docs',
      '--model',
      'opus'
    ])
  })

  it.each(ROUND_TRIP_FIXTURES[shell])('keeps %s', (typed, token) => {
    expect(
      merged(
        'claude',
        '--dangerously-skip-permissions --add-dir "x y"',
        `--add-dir ${typed}`,
        shell
      )
    ).toEqual(['--dangerously-skip-permissions', '--add-dir', 'x y', '--add-dir', token])
  })

  it('builds the startup command with extras before the prompt', () => {
    const agentArgs = mergeExtraAgentArgs({
      agent: 'claude',
      defaultArgs: '--dangerously-skip-permissions --model sonnet',
      extraAgentArgs: "--model opus --add-dir 'a b'",
      shell
    })
    if (!agentArgs.ok) {
      throw new Error(agentArgs.error)
    }
    const plan = buildAgentStartupPlan({
      agent: 'claude',
      prompt: 'do the thing',
      cmdOverrides: {},
      platform: shell === 'posix' ? 'linux' : 'win32',
      shell,
      agentArgs: agentArgs.agentArgs
    })
    const argv = tokenizeStartupCommand(plan?.launchCommand ?? '', shell)
    expect(argv).toMatchObject({
      ok: true,
      tokens: [
        'claude',
        '--dangerously-skip-permissions',
        '--model',
        'opus',
        '--add-dir',
        'a b',
        'do the thing'
      ]
    })
  })
})
