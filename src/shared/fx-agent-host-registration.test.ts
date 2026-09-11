import { describe, expect, it } from 'vitest'
import {
  getTuiAgentDetectionProbeCommands,
  KNOWN_TUI_AGENT_DETECTION_COMMANDS,
  resolveDetectedTuiAgentIds
} from './tui-agent-detection-commands'
import {
  recognizeAgentProcess,
  recognizeAgentProcessFromCommandLine
} from './agent-process-recognition'
import { buildAgentStartupPlan } from './tui-agent-startup'
import { TUI_AGENT_CONFIG } from './tui-agent-config'
import {
  MANUAL_TUI_AGENT_ENV,
  resolveTuiAgentPermissionMode,
  YOLO_TUI_AGENT_ENV
} from './tui-agent-permissions'

describe('fx terminal agent host registration', () => {
  it('detects bare fx on supported execution hosts but not native Windows', () => {
    const commands = KNOWN_TUI_AGENT_DETECTION_COMMANDS.filter((command) => command.id === 'fx')

    expect(commands).toEqual([{ id: 'fx', cmd: 'fx', unsupportedRuntimes: ['win32'] }])
    expect(getTuiAgentDetectionProbeCommands(commands, 'darwin')).toEqual(['fx'])
    expect(getTuiAgentDetectionProbeCommands(commands, 'linux')).toEqual(['fx'])
    expect(getTuiAgentDetectionProbeCommands(commands, 'wsl')).toEqual(['fx'])
    expect(getTuiAgentDetectionProbeCommands(commands, 'win32')).toEqual([])
    expect(resolveDetectedTuiAgentIds(commands, new Set(['fx']), 'linux')).toEqual(['fx'])
    expect(resolveDetectedTuiAgentIds(commands, new Set(['fx']), 'wsl')).toEqual(['fx'])
    expect(resolveDetectedTuiAgentIds(commands, new Set(['fx']), 'win32')).toEqual([])
  })

  it('launches the interactive CLI and delivers the initial prompt after startup', () => {
    const expected = {
      agent: 'fx' as const,
      launchCommand: 'fx',
      expectedProcess: 'fx',
      followupPrompt: 'inspect this folder',
      launchConfig: { agentCommand: 'fx', agentArgs: '', agentEnv: {} }
    }

    expect(
      buildAgentStartupPlan({
        agent: 'fx',
        prompt: 'inspect this folder',
        cmdOverrides: {},
        platform: 'linux'
      })
    ).toEqual(expected)
    expect(
      buildAgentStartupPlan({
        agent: 'fx',
        prompt: 'inspect this folder',
        cmdOverrides: {},
        platform: 'linux',
        isRemote: true
      })
    ).toEqual(expected)
  })

  it('keeps folder launches independent of Git and honors a custom command', () => {
    const plan = buildAgentStartupPlan({
      agent: 'fx',
      prompt: 'inspect this folder',
      cmdOverrides: { fx: '/opt/tools/fx' },
      platform: 'darwin'
    })

    expect(plan?.launchCommand).toBe('/opt/tools/fx')
    expect(plan?.followupPrompt).toBe('inspect this folder')
    expect(plan?.expectedProcess).toBe('fx')
  })

  it('launches bare fx with an explicit permission environment for Manual and Yolo', () => {
    const manual = buildAgentStartupPlan({
      agent: 'fx',
      prompt: 'work',
      cmdOverrides: {},
      platform: 'linux',
      agentArgs: '',
      agentEnv: MANUAL_TUI_AGENT_ENV.fx
    })
    const yolo = buildAgentStartupPlan({
      agent: 'fx',
      prompt: 'work',
      cmdOverrides: {},
      platform: 'linux',
      agentArgs: '',
      agentEnv: YOLO_TUI_AGENT_ENV.fx
    })

    expect(manual).toMatchObject({
      launchCommand: 'fx',
      env: { FX_PERMISSION_MODE: 'ask' },
      launchConfig: { agentArgs: '', agentEnv: { FX_PERMISSION_MODE: 'ask' } }
    })
    expect(yolo).toMatchObject({
      launchCommand: 'fx',
      env: { FX_PERMISSION_MODE: 'full-access' },
      launchConfig: { agentArgs: '', agentEnv: { FX_PERMISSION_MODE: 'full-access' } }
    })
    expect(
      resolveTuiAgentPermissionMode({ agent: 'fx', agentArgs: '', agentEnv: manual?.env })
    ).toBe('manual')
    expect(resolveTuiAgentPermissionMode({ agent: 'fx', agentArgs: '', agentEnv: yolo?.env })).toBe(
      'yolo'
    )
  })

  it('recognizes only bare and resume-mode fx processes as interactive', () => {
    const interactive = { agent: 'fx' as const, processName: 'fx' }
    expect(recognizeAgentProcess('/home/dev/.local/bin/fx')).toEqual(interactive)
    expect(recognizeAgentProcessFromCommandLine('fx')).toEqual(interactive)
    expect(recognizeAgentProcessFromCommandLine('fx --add-dir ask')).toEqual(interactive)
    expect(recognizeAgentProcessFromCommandLine('fx -c')).toEqual(interactive)
    expect(recognizeAgentProcessFromCommandLine('fx -r')).toEqual(interactive)
    expect(recognizeAgentProcessFromCommandLine('fx --resume last')).toEqual(interactive)
    expect(recognizeAgentProcessFromCommandLine('fx --resume-session-123')).toEqual(interactive)
    expect(recognizeAgentProcessFromCommandLine('fx session resume last')).toEqual(interactive)

    for (const command of [
      'fx ask "explain this"',
      'fx --context-limit model=1mb ask "explain this"',
      'fx acp',
      'fx pr',
      'fx issue',
      'fx status',
      'fx sessions',
      'fx session migrate abc',
      'fx -c status',
      'fx session resume last extra',
      'fx unknown-command',
      'fx --help'
    ]) {
      expect(recognizeAgentProcessFromCommandLine(command), command).toBeNull()
    }
  })

  it('pins fx to the bare interactive executable and post-start injection', () => {
    expect(TUI_AGENT_CONFIG.fx).toMatchObject({
      detectCmd: 'fx',
      launchCmd: 'fx',
      expectedProcess: 'fx',
      promptInjectionMode: 'stdin-after-start',
      detectUnsupportedRuntimes: ['win32']
    })
  })
})
