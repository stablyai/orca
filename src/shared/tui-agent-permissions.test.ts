import { describe, expect, it } from 'vitest'
import {
  applyAgentPermissionMode,
  AUTO_TUI_AGENT_ARGS,
  isAutoApprovingPermissionMode,
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

  it('recognizes the applied auto profile as auto (verified agents only)', () => {
    const applied = applyAgentPermissionMode({
      mode: 'auto',
      agentDefaultArgs: YOLO_TUI_AGENT_ARGS,
      agentDefaultEnv: YOLO_TUI_AGENT_ENV
    })
    expect(resolveAgentPermissionModeSummary(applied)).toBe('auto')
    expect(applied.agentDefaultArgs.claude).toBe(AUTO_TUI_AGENT_ARGS.claude)
    expect(applied.agentDefaultArgs.codex).toBe(AUTO_TUI_AGENT_ARGS.codex)
    expect(applied.agentDefaultArgs.grok).toBe(AUTO_TUI_AGENT_ARGS.grok)
    // Why: agents without a verified auto preset must not inherit yolo when Auto is chosen.
    expect(applied.agentDefaultArgs.gemini).toBe('')
    expect(applied.agentDefaultEnv.goose).toEqual({})
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

  it('preserves custom agent arguments when applying auto mode', () => {
    const result = applyAgentPermissionMode({
      mode: 'auto',
      agentDefaultArgs: {
        claude: '--model sonnet',
        codex: YOLO_TUI_AGENT_ARGS.codex
      },
      agentDefaultEnv: {}
    })

    expect(result.agentDefaultArgs.claude).toBe('--model sonnet')
    expect(result.agentDefaultArgs.codex).toBe(AUTO_TUI_AGENT_ARGS.codex)
  })

  it('overwrites auto preset args when switching to yolo or manual', () => {
    const fromAuto = applyAgentPermissionMode({
      mode: 'yolo',
      agentDefaultArgs: {
        claude: AUTO_TUI_AGENT_ARGS.claude,
        codex: AUTO_TUI_AGENT_ARGS.codex
      },
      agentDefaultEnv: {}
    })
    expect(fromAuto.agentDefaultArgs.claude).toBe(YOLO_TUI_AGENT_ARGS.claude)
    expect(fromAuto.agentDefaultArgs.codex).toBe(YOLO_TUI_AGENT_ARGS.codex)

    const toManual = applyAgentPermissionMode({
      mode: 'manual',
      agentDefaultArgs: {
        claude: AUTO_TUI_AGENT_ARGS.claude
      },
      agentDefaultEnv: {}
    })
    expect(toManual.agentDefaultArgs.claude).toBe('')
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

  it('reports mixed when auto and yolo presets are combined', () => {
    expect(
      resolveAgentPermissionModeSummary({
        agentDefaultArgs: {
          ...YOLO_TUI_AGENT_ARGS,
          claude: AUTO_TUI_AGENT_ARGS.claude
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

  it('resolves one Codex auto launch as auto', () => {
    expect(
      resolveTuiAgentPermissionMode({
        agent: 'codex',
        agentArgs: AUTO_TUI_AGENT_ARGS.codex,
        agentEnv: {}
      })
    ).toBe('auto')
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

  it('treats yolo and auto as auto-approving permission modes', () => {
    expect(isAutoApprovingPermissionMode('yolo')).toBe(true)
    expect(isAutoApprovingPermissionMode('auto')).toBe(true)
    expect(isAutoApprovingPermissionMode('manual')).toBe(false)
    expect(isAutoApprovingPermissionMode('mixed')).toBe(false)
  })
})
