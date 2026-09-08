import { describe, expect, it } from 'vitest'
import {
  applyAgentPermissionMode,
  applyTuiAgentPermissionMode,
  AUTO_TUI_AGENT_ARGS,
  AUTO_TUI_AGENT_ENV,
  supportsTuiAgentAutoPermissionMode,
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

describe('intermediate permission presets', () => {
  it('round trips all presets including manual fallbacks from an Auto profile', () => {
    let profile = applyAgentPermissionMode({ mode: 'yolo' })
    for (const mode of ['auto', 'manual', 'yolo', 'auto'] as const) {
      profile = applyAgentPermissionMode({ ...profile, mode })
      expect(resolveAgentPermissionModeSummary(profile)).toBe(mode)
      for (const agent of Object.keys(
        YOLO_TUI_AGENT_ARGS
      ) as (keyof typeof YOLO_TUI_AGENT_ARGS)[]) {
        expect(
          resolveTuiAgentPermissionMode({ agent, agentArgs: profile.agentDefaultArgs[agent] })
        ).toBe(mode === 'auto' && !supportsTuiAgentAutoPermissionMode(agent) ? 'manual' : mode)
      }
      expect(
        resolveTuiAgentPermissionMode({ agent: 'goose', agentEnv: profile.agentDefaultEnv.goose })
      ).toBe(mode)
    }
  })

  it('keeps unknown and custom settings when applying a global preset', () => {
    const profile = applyAgentPermissionMode({
      mode: 'auto',
      agentDefaultArgs: {
        claude: '--model custom',
        opencode: '--port 1234',
        codex: ' --approve-for-me '
      },
      agentDefaultEnv: {
        goose: { GOOSE_MODE: 'approve', CUSTOM: 'value' },
        claude: { CUSTOM: 'value' }
      }
    })
    expect(profile.agentDefaultArgs.claude).toBe('--model custom')
    expect(profile.agentDefaultArgs.codex).toBe(' --approve-for-me ')
    expect(profile.agentDefaultArgs.opencode).toBe('--port 1234')
    expect(profile.agentDefaultEnv.goose).toEqual({ GOOSE_MODE: 'approve', CUSTOM: 'value' })
    expect(profile.agentDefaultEnv.claude).toEqual({ CUSTOM: 'value' })
    expect(resolveAgentPermissionModeSummary(profile)).toBe('mixed')
  })

  it('reports custom per-agent choices as mixed rather than misleadingly showing Auto or Yolo', () => {
    const profile = applyAgentPermissionMode({ mode: 'auto' })
    expect(
      resolveAgentPermissionModeSummary({
        ...profile,
        agentDefaultArgs: { ...profile.agentDefaultArgs, codex: '' }
      })
    ).toBe('mixed')
    expect(
      resolveAgentPermissionModeSummary({
        ...profile,
        agentDefaultArgs: { ...profile.agentDefaultArgs, amp: YOLO_TUI_AGENT_ARGS.amp }
      })
    ).toBe('mixed')
  })

  it('uses the existing args and env launch fields for per-agent choices', () => {
    expect(
      applyTuiAgentPermissionMode({
        agent: 'claude',
        mode: 'auto',
        agentArgs: YOLO_TUI_AGENT_ARGS.claude,
        agentEnv: { CUSTOM: 'value' }
      })
    ).toEqual({ agentArgs: AUTO_TUI_AGENT_ARGS.claude, agentEnv: { CUSTOM: 'value' } })
    expect(
      applyTuiAgentPermissionMode({
        agent: 'goose',
        mode: 'auto',
        agentEnv: YOLO_TUI_AGENT_ENV.goose
      })
    ).toEqual({ agentArgs: '', agentEnv: AUTO_TUI_AGENT_ENV.goose })
    expect(
      applyTuiAgentPermissionMode({
        agent: 'amp',
        mode: 'auto',
        agentArgs: YOLO_TUI_AGENT_ARGS.amp
      })
    ).toEqual({ agentArgs: '', agentEnv: {} })
  })
})
