import { describe, expect, it } from 'vitest'
import {
  applyAgentPermissionMode,
  hasYoloTuiAgentLaunch,
  resolveAgentPermissionModeSummary,
  resolveTuiAgentPermissionMode,
  YOLO_TUI_AGENT_ARGS,
  YOLO_TUI_AGENT_ENV
} from './tui-agent-permissions'

describe('tui agent permissions', () => {
  it('recognizes the current default profile as yolo', () => {
    expect(
      resolveAgentPermissionModeSummary({
        agentDefaultArgs: YOLO_TUI_AGENT_ARGS,
        agentDefaultEnv: YOLO_TUI_AGENT_ENV
      })
    ).toBe('yolo')
  })

  it('recognizes an empty profile as manual', () => {
    expect(resolveAgentPermissionModeSummary({ agentDefaultArgs: {}, agentDefaultEnv: {} })).toBe(
      'manual'
    )
  })

  it('preserves custom agent arguments when applying manual mode', () => {
    const result = applyAgentPermissionMode({
      mode: 'manual',
      agentDefaultArgs: {
        claude: '--dangerously-skip-permissions',
        codex: '--model gpt-5'
      },
      agentDefaultEnv: YOLO_TUI_AGENT_ENV
    })

    expect(result.agentDefaultArgs.claude).toBe('')
    expect(result.agentDefaultArgs.codex).toBe('--model gpt-5')
    expect(result.agentDefaultEnv.goose).toEqual({})
  })

  it('reports mixed when custom arguments are present', () => {
    expect(
      resolveAgentPermissionModeSummary({
        agentDefaultArgs: {
          ...YOLO_TUI_AGENT_ARGS,
          codex: '--model gpt-5'
        },
        agentDefaultEnv: YOLO_TUI_AGENT_ENV
      })
    ).toBe('mixed')
  })

  it('resolves one Codex yolo launch as yolo', () => {
    expect(
      resolveTuiAgentPermissionMode({
        agent: 'codex',
        agentArgs: YOLO_TUI_AGENT_ARGS.codex,
        agentEnv: {}
      })
    ).toBe('yolo')
  })

  it('resolves one empty Codex launch as manual', () => {
    expect(resolveTuiAgentPermissionMode({ agent: 'codex', agentArgs: '', agentEnv: {} })).toBe(
      'manual'
    )
  })

  it('resolves custom Codex permission arguments as mixed', () => {
    expect(
      resolveTuiAgentPermissionMode({
        agent: 'codex',
        agentArgs: '--ask-for-approval on-request',
        agentEnv: {}
      })
    ).toBe('mixed')
  })

  it('resolves env-driven yolo launches', () => {
    expect(
      resolveTuiAgentPermissionMode({
        agent: 'goose',
        agentArgs: '',
        agentEnv: YOLO_TUI_AGENT_ENV.goose
      })
    ).toBe('yolo')
  })
})

describe('hasYoloTuiAgentLaunch', () => {
  it('grants bypass when the flag sits alongside other args', () => {
    expect(
      hasYoloTuiAgentLaunch({
        agent: 'claude',
        agentArgs: '--dangerously-skip-permissions --verbose'
      })
    ).toBe(true)
  })

  it('grants bypass for the bare flag', () => {
    expect(
      hasYoloTuiAgentLaunch({ agent: 'claude', agentArgs: '--dangerously-skip-permissions' })
    ).toBe(true)
  })

  it('withholds bypass when the flag is absent', () => {
    expect(hasYoloTuiAgentLaunch({ agent: 'claude', agentArgs: '--verbose' })).toBe(false)
    expect(hasYoloTuiAgentLaunch({ agent: 'claude', agentArgs: '' })).toBe(false)
    expect(hasYoloTuiAgentLaunch({ agent: 'claude' })).toBe(false)
  })

  it('reads env-granted yolo for agents that use it', () => {
    expect(hasYoloTuiAgentLaunch({ agent: 'goose', agentEnv: { GOOSE_MODE: 'auto' } })).toBe(true)
    expect(hasYoloTuiAgentLaunch({ agent: 'goose', agentEnv: {} })).toBe(false)
  })

  it('differs from the exact-preset check that reports mixed', () => {
    const agentArgs = '--dangerously-skip-permissions --verbose'
    expect(resolveTuiAgentPermissionMode({ agent: 'claude', agentArgs })).toBe('mixed')
    expect(hasYoloTuiAgentLaunch({ agent: 'claude', agentArgs })).toBe(true)
  })
})
