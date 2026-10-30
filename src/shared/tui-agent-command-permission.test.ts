import { describe, expect, it } from 'vitest'
import { resolveAgentStartupPlanInputs } from './agent-startup-plan-inputs'
import { buildAgentStartupPlan } from './tui-agent-startup'
import { quoteStartupArg, tokenizeStartupCommand } from './tui-agent-startup-shell'
import type { TuiAgent } from './tui-agent'
import { resolveAgentLaunchCommand } from './tui-agent-launch-command'

describe.each(['posix', 'powershell', 'cmd'] as const)('command permissions on %s', (shell) => {
  function launch(command: string, agent: TuiAgent = 'kimi', picked = false, agentArgs = '') {
    const plan = buildAgentStartupPlan({
      ...resolveAgentStartupPlanInputs({
        agent,
        settings: {
          agentPermissionDefault: 'full-access',
          agentCmdOverrides: { [agent]: command },
          agentDefaultArgs: { [agent]: agentArgs }
        },
        platform: shell === 'posix' ? 'linux' : 'win32',
        isRemote: shell === 'posix',
        shell,
        ...(picked ? { sessionOptions: { permissionMode: 'full-access' } } : {})
      }),
      prompt: '',
      allowEmptyPromptLaunch: true
    })
    expect(plan).not.toBeNull()
    if (!plan) {
      throw new Error('Expected a launch plan')
    }
    return {
      plan,
      argv: tokenizeStartupCommand(plan.launchCommand, shell),
      recorded: tokenizeStartupCommand(plan.launchConfig.agentCommand ?? '', shell)
    }
  }

  it.each(['--yolo', '-y', '--yes', '--auto-approve'])(
    'keeps user-authored %s in either settings field without adding --auto',
    (flag) => {
      for (const picked of [false, true]) {
        for (const inCommand of [false, true]) {
          const result = launch(
            inCommand ? `kimi ${flag}` : 'kimi',
            'kimi',
            picked,
            inCommand ? '--model kimi-k2' : `${flag} --model kimi-k2`
          )
          const expected = { ok: true, tokens: ['kimi', flag, '--model', 'kimi-k2'] }
          expect(result.argv).toMatchObject(expected)
          expect(result.recorded).toMatchObject(expected)
          expect(result.plan.sessionOptions?.permissionMode).toBeUndefined()
        }
      }
    }
  )

  it.each([
    ['kimi', 'kimi', ['kimi', '--auto']],
    [
      'kimi',
      'npx --cache /tmp/kimi-npm @moonshot-ai/kimi-code --yolo',
      ['npx', '--cache', '/tmp/kimi-npm', '@moonshot-ai/kimi-code', '--yolo']
    ],
    [
      'kimi',
      'npx --cache=/tmp/kimi-npm @moonshot-ai/kimi-code',
      ['npx', '--cache=/tmp/kimi-npm', '@moonshot-ai/kimi-code', '--auto']
    ],
    ['gemini', 'ssh -y devbox gemini', ['ssh', '-y', 'devbox', 'gemini', '--yolo']],
    ['gemini', 'ssh -p 2222 devbox gemini', ['ssh', '-p', '2222', 'devbox', 'gemini', '--yolo']],
    ['gemini', 'ssh devbox gemini -y', ['ssh', 'devbox', 'gemini', '-y']],
    [
      'kimi',
      'npx --unknown-option value kimi --yolo',
      ['npx', '--unknown-option', 'value', 'kimi', '--yolo']
    ],
    ['gemini', 'unknown-wrapper -y gemini', ['unknown-wrapper', '-y', 'gemini']],
    ['kimi', 'npx --unknown-option value kimi', ['npx', '--unknown-option', 'value', 'kimi']],
    ['kimi', 'npx -y kimi', ['npx', '-y', 'kimi', '--auto']],
    ['gemini', 'npx -y @google/gemini-cli', ['npx', '-y', '@google/gemini-cli', '--yolo']],
    ['kimi', 'npx -y kimi --yolo', ['npx', '-y', 'kimi', '--yolo']],
    ['kimi', 'my-kimi --yolo', ['my-kimi', '--yolo']],
    ['kimi', 'bunx --bun kimi --yolo', ['bunx', '--bun', 'kimi', '--yolo']],
    ['kimi', 'python -m kimi_cli --yolo', ['python', '-m', 'kimi_cli', '--yolo']],
    ['kimi', 'npm exec -y -- kimi --yolo', ['npm', 'exec', '-y', '--', 'kimi', '--yolo']],
    ['kimi', 'npm exec -p -- kimi --yolo', ['npm', 'exec', '-p', '--', 'kimi', '--yolo']],
    ['kimi', 'npx -p kimi-code kimi --yolo', ['npx', '-p', 'kimi-code', 'kimi', '--yolo']],
    [
      'gemini',
      'npm exec -y -- @google/gemini-cli',
      ['npm', 'exec', '-y', '--', '@google/gemini-cli', '--yolo']
    ],
    [
      'kimi',
      'npx --package kimi-code -- kimi -y',
      ['npx', '--package', 'kimi-code', '--', 'kimi', '-y']
    ],
    ['kimi', 'uvx --from kimi-cli kimi --yolo', ['uvx', '--from', 'kimi-cli', 'kimi', '--yolo']],
    ['kimi', 'env CONFIG=1 npx -y kimi', ['env', 'CONFIG=1', 'npx', '-y', 'kimi', '--auto']],
    ['kimi', 'kimi --model "--yolo"', ['kimi', '--model', '--yolo', '--auto']]
  ] as const)('respects argument ownership for %s via %s', (agent, command, tokens) => {
    for (const picked of [false, true]) {
      const result = launch(command, agent, picked)
      expect(result.argv).toMatchObject({ ok: true, tokens })
      expect(result.recorded).toMatchObject({ ok: true, tokens })
    }
  })

  it.each(['npx --unknown-option value kimi', 'unknown-wrapper -y gemini'])(
    'does not record a permission choice as applied to opaque command %s',
    (command) => {
      const result = launch(command, command.startsWith('npx') ? 'kimi' : 'gemini', true)
      expect(result.plan.sessionOptions?.permissionMode).toBeUndefined()
      expect(result.plan.launchCommand).toBe(command)
      expect(result.plan.launchConfig.agentCommand).toBe(command)
    }
  )

  it('keeps literal executable paths and their permission across session picks', () => {
    const executable =
      shell === 'posix' ? '/opt/my tools/kimi' : String.raw`C:\Program Files\Kimi\kimi.exe`
    const prefix = shell === 'powershell' ? '& ' : ''
    const command = `${prefix}${quoteStartupArg(executable, shell)} --yolo`
    for (const picked of [false, true]) {
      const result = launch(command, 'kimi', picked)
      expect(result.plan.launchCommand).toBe(command)
      expect(result.plan.launchConfig.agentCommand).toBe(command)
    }
  })

  it('keeps legacy defaults from adding a conflicting permission', () => {
    const plan = buildAgentStartupPlan({
      ...resolveAgentStartupPlanInputs({
        agent: 'kimi',
        settings: { agentCmdOverrides: { kimi: 'kimi --yolo' } },
        platform: shell === 'posix' ? 'linux' : 'win32',
        isRemote: false,
        shell
      }),
      prompt: '',
      allowEmptyPromptLaunch: true
    })
    expect(plan?.launchCommand).toBe('kimi --yolo')
  })

  it('still rejects model conflicts in an explicit session launch', () => {
    const result = resolveAgentLaunchCommand({
      agent: 'claude',
      cmdOverrides: { claude: 'claude --model haiku' },
      platform: shell === 'posix' ? 'linux' : 'win32',
      shell,
      sessionOptions: { model: 'opus' },
      sessionOptionsOverrideAgentArgs: true
    })
    expect(result).toMatchObject({ ok: false })
  })
})

it('uses POSIX escaping for default and explicit command permissions', () => {
  const command = String.raw`kimi --add-dir /tmp/notes\ --yolo`
  for (const picked of [false, true]) {
    const plan = buildAgentStartupPlan({
      ...resolveAgentStartupPlanInputs({
        agent: 'kimi',
        settings: {
          agentPermissionDefault: 'full-access',
          agentCmdOverrides: { kimi: command },
          agentDefaultArgs: { kimi: '' }
        },
        platform: 'linux',
        isRemote: true,
        shell: 'posix',
        ...(picked ? { sessionOptions: { permissionMode: 'full-access' } } : {})
      }),
      prompt: '',
      allowEmptyPromptLaunch: true
    })
    expect(plan).not.toBeNull()
    expect(tokenizeStartupCommand(plan?.launchCommand ?? '', 'posix')).toMatchObject({
      ok: true,
      tokens: ['kimi', '--add-dir', '/tmp/notes --yolo', '--auto']
    })
    expect(tokenizeStartupCommand(plan?.launchConfig.agentCommand ?? '', 'posix')).toMatchObject({
      ok: true,
      tokens: ['kimi', '--add-dir', '/tmp/notes --yolo', '--auto']
    })
  }
})
