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
import { resolveTuiAgentPermissionMode, YOLO_TUI_AGENT_ARGS } from './tui-agent-permissions'

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

  it('maps Manual to bare fx and Yolo to the documented full-access flag', () => {
    const manual = buildAgentStartupPlan({
      agent: 'fx',
      prompt: 'work',
      cmdOverrides: {},
      platform: 'linux',
      agentArgs: ''
    })
    const yolo = buildAgentStartupPlan({
      agent: 'fx',
      prompt: 'work',
      cmdOverrides: {},
      platform: 'linux',
      agentArgs: YOLO_TUI_AGENT_ARGS.fx
    })

    expect(manual?.launchCommand).toBe('fx')
    expect(yolo?.launchCommand).toBe("fx '--full-access'")
    expect(resolveTuiAgentPermissionMode({ agent: 'fx', agentArgs: '', agentEnv: {} })).toBe(
      'manual'
    )
    expect(
      resolveTuiAgentPermissionMode({
        agent: 'fx',
        agentArgs: YOLO_TUI_AGENT_ARGS.fx,
        agentEnv: {}
      })
    ).toBe('yolo')
  })

  it('recognizes interactive fx processes but excludes ask and ACP commands', () => {
    expect(recognizeAgentProcess('/home/dev/.local/bin/fx')).toEqual({
      agent: 'fx',
      processName: 'fx'
    })
    expect(recognizeAgentProcessFromCommandLine('fx')).toEqual({ agent: 'fx', processName: 'fx' })
    expect(recognizeAgentProcessFromCommandLine('fx --full-access')).toEqual({
      agent: 'fx',
      processName: 'fx'
    })
    expect(recognizeAgentProcessFromCommandLine('fx ask "explain this"')).toBeNull()
    expect(recognizeAgentProcessFromCommandLine('fx acp')).toBeNull()
    expect(recognizeAgentProcessFromCommandLine('fx --add-dir ask')).toEqual({
      agent: 'fx',
      processName: 'fx'
    })
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
