import { describe, expect, it } from 'vitest'
import { resolveAgentLaunchCommand, terminalSessionOptionInputs } from './tui-agent-launch-command'
import { resolveAgentStartupPlanInputs } from './agent-startup-plan-inputs'
import { clearTerminalEffortArgs } from './terminal-effort-option-edit'
import { tokenizeStartupCommand } from './tui-agent-startup-shell'

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
  it('preserves picks when configured arguments contain flags after --', () => {
    const result = launch({
      agentArgs: '-- --model haiku',
      sessionOptions: { model: 'opus', effort: 'high' }
    })
    expect(result.command).toBe("claude '--model' 'opus' '--effort' 'high' '--' '--model' 'haiku'")
    expect(result.appliedSessionOptions).toEqual({ model: 'opus', effort: 'high' })
  })
})

function editedLaunch(args: Parameters<typeof resolveAgentStartupPlanInputs>[0]) {
  const inputs = resolveAgentStartupPlanInputs(args)
  const result = resolveAgentLaunchCommand({ ...inputs, shell: 'posix' })
  if (!result.ok) {
    throw new Error(result.error)
  }
  return { inputs, argv: tokenizeStartupCommand(result.command, 'posix') }
}

it('applies effort deletion to current destination defaults, actions and Arguments without mutating settings', () => {
  const settings = {
    agentCmdOverrides: { antigravity: 'agy' },
    agentPermissionDefault: 'full-access' as const,
    agentDefaultArgs: { antigravity: '--effort=high --add-dir new' },
    agentLaunchChoices: { antigravity: { options: { effort: 'low' } } }
  }
  const before = JSON.stringify(settings)
  const request = {
    agent: 'antigravity' as const,
    settings,
    platform: 'linux' as const,
    shell: 'posix' as const,
    isRemote: false,
    sessionOptions: { effort: 'medium' }
  }
  expect(editedLaunch(request).argv).toMatchObject({
    ok: true,
    tokens: ['agy', '--dangerously-skip-permissions', '--add-dir', 'new']
  })
  expect(editedLaunch({ ...request, terminalOptionEdits: { effort: null } }).argv).toMatchObject({
    ok: true,
    tokens: ['agy', '--dangerously-skip-permissions', '--add-dir', 'new']
  })
  expect(
    editedLaunch({
      ...request,
      terminalOptionEdits: { effort: null },
      agentArgs: '--effort low --add-dir authored'
    }).argv
  ).toMatchObject({
    ok: true,
    tokens: ['agy', '--add-dir', 'authored']
  })
  expect(
    editedLaunch({ ...request, terminalOptionEdits: { effort: null }, agentArgs: null }).argv
  ).toMatchObject({ ok: true, tokens: ['agy'] })
  expect(JSON.stringify(settings)).toBe(before)
})

it.each([
  [
    'claude',
    '--effort low --add-dir docs',
    { effort: 'high' },
    ['claude', '--add-dir', 'docs', '--effort', 'high'],
    ['claude', '--add-dir', 'docs']
  ],
  [
    'codex',
    '-c model_reasoning_effort=low -c personality=friendly',
    { effort: 'high' },
    [
      'codex',
      '-c',
      'disable_paste_burst=true',
      '-c',
      'personality=friendly',
      '-c',
      'model_reasoning_effort=high'
    ],
    ['codex', '-c', 'disable_paste_burst=true', '-c', 'personality=friendly']
  ]
] as const)(
  'keeps %s ordinary launch semantics and clears only requested effort',
  (agent, raw, sessionOptions, ordinary, cleared) => {
    const request = {
      agent,
      settings: { agentDefaultArgs: { [agent]: raw } },
      sessionOptions,
      platform: 'linux' as const,
      shell: 'posix' as const,
      isRemote: false
    }
    expect(editedLaunch(request).argv).toMatchObject({ ok: true, tokens: ordinary })
    expect(editedLaunch({ ...request, terminalOptionEdits: { effort: null } }).argv).toMatchObject({
      ok: true,
      tokens: cleared
    })
  }
)

it('preserves literal composed models and opaque Arguments while clearing dedicated effort', () => {
  const request = {
    agent: 'cursor' as const,
    settings: {
      agentDefaultArgs: { cursor: '--model sonnet-4.5-thinking --add-dir docs' },
      agentLaunchChoices: { cursor: { options: { effort: 'high' } } }
    },
    terminalOptionEdits: { effort: null } as const,
    platform: 'linux' as const,
    shell: 'posix' as const,
    isRemote: false
  }
  expect(editedLaunch(request).argv).toMatchObject({
    ok: true,
    tokens: ['cursor-agent', '--model', 'sonnet-4.5-thinking', '--add-dir', 'docs']
  })
  const opaque = terminalSessionOptionInputs({
    agent: 'antigravity',
    settings: { agentLaunchChoices: { antigravity: { options: { effort: 'low' } } } },
    agentArgs: '--effort low | tee result',
    sessionOptions: undefined,
    terminalOptionEdits: { effort: null },
    shell: 'posix'
  })
  expect(opaque).toEqual({ agentArgs: '--effort low | tee result' })
})

it('deletes only a proven effort before an opaque suffix without rewriting that suffix', () => {
  expect(
    clearTerminalEffortArgs(
      'antigravity',
      '--dangerously-skip-permissions --effort=high  --add-dir "current folder"  '
    )
  ).toBe('--dangerously-skip-permissions   --add-dir "current folder"  ')
  expect(
    clearTerminalEffortArgs(
      'antigravity',
      '--dangerously-skip-permissions --effort low --future-option opaque'
    )
  ).toBe('--dangerously-skip-permissions  --future-option opaque')
})

it.each([
  ['antigravity', '--future-option opaque --effort low'],
  ['antigravity', '--model --effort low'],
  ['claude', '--system-prompt --effort low'],
  ['antigravity', '-- --effort low'],
  ['antigravity', '--effort low --effort high'],
  ['antigravity', "--effort 'low' --add-dir docs"],
  ['antigravity', '--effort "low'],
  ['antigravity', '--effort low | tee output']
] as const)('preserves protected effort text for %s: %s', (agent, raw) => {
  expect(clearTerminalEffortArgs(agent, raw)).toBe(raw)
})
