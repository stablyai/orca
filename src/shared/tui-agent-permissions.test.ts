import { describe, expect, it } from 'vitest'
import {
  applyAgentPermissionMode,
  AUTO_TUI_AGENT_ARGS,
  AUTO_TUI_AGENT_ENV,
  hasAutoAgentPermissionPreset,
  isAutoApprovingPermissionMode,
  projectAgentPermissionSettingsForLegacyClient,
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

  it('recognizes the applied auto profile as auto (vendor-supported harnesses)', () => {
    const applied = applyAgentPermissionMode({
      mode: 'auto',
      agentDefaultArgs: YOLO_TUI_AGENT_ARGS,
      agentDefaultEnv: YOLO_TUI_AGENT_ENV
    })
    expect(resolveAgentPermissionModeSummary(applied)).toBe('auto')
    expect(applied.agentDefaultArgs.claude).toBe(AUTO_TUI_AGENT_ARGS.claude)
    expect(applied.agentDefaultArgs['claude-agent-teams']).toBe(
      AUTO_TUI_AGENT_ARGS['claude-agent-teams']
    )
    expect(applied.agentDefaultArgs.openclaude).toBe(AUTO_TUI_AGENT_ARGS.openclaude)
    expect(applied.agentDefaultArgs.codex).toBe(AUTO_TUI_AGENT_ARGS.codex)
    expect(applied.agentDefaultArgs.antigravity).toBe(AUTO_TUI_AGENT_ARGS.antigravity)
    expect(applied.agentDefaultArgs.gemini).toBe(AUTO_TUI_AGENT_ARGS.gemini)
    expect(applied.agentDefaultArgs['qwen-code']).toBe(AUTO_TUI_AGENT_ARGS['qwen-code'])
    expect(applied.agentDefaultArgs.grok).toBe(AUTO_TUI_AGENT_ARGS.grok)
    expect(applied.agentDefaultArgs.devin).toBe(AUTO_TUI_AGENT_ARGS.devin)
    expect(applied.agentDefaultEnv.goose).toEqual(AUTO_TUI_AGENT_ENV.goose)
    // Why: agents without a verified auto preset must not inherit yolo when Auto is chosen.
    expect(applied.agentDefaultArgs.copilot).toBe('')
    expect(applied.agentDefaultArgs.cursor).toBe('')
    expect(applied.agentDefaultArgs.aider).toBe('')
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

  it('preserves custom agent env when applying auto mode', () => {
    const customGoose = { GOOSE_MODE: 'chat', EXTRA: '1' }
    const result = applyAgentPermissionMode({
      mode: 'auto',
      agentDefaultArgs: {},
      agentDefaultEnv: { goose: customGoose }
    })

    expect(result.agentDefaultEnv.goose).toEqual(customGoose)
  })

  it('preserves whitespace-only arguments when applying permission modes', () => {
    const result = applyAgentPermissionMode({
      mode: 'auto',
      agentDefaultArgs: {
        claude: '   ',
        codex: '\t'
      },
      agentDefaultEnv: {}
    })

    expect(result.agentDefaultArgs.claude).toBe('   ')
    expect(result.agentDefaultArgs.codex).toBe('\t')
  })

  it('preserves whitespace-padded presets when applying permission modes', () => {
    const result = applyAgentPermissionMode({
      mode: 'manual',
      agentDefaultArgs: {
        claude: ` ${YOLO_TUI_AGENT_ARGS.claude}`,
        codex: `${AUTO_TUI_AGENT_ARGS.codex} `
      },
      agentDefaultEnv: {}
    })

    expect(result.agentDefaultArgs.claude).toBe(` ${YOLO_TUI_AGENT_ARGS.claude}`)
    expect(result.agentDefaultArgs.codex).toBe(`${AUTO_TUI_AGENT_ARGS.codex} `)
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

  it('reports mixed when an auto-capable agent stays manual', () => {
    const applied = applyAgentPermissionMode({
      mode: 'auto',
      agentDefaultArgs: YOLO_TUI_AGENT_ARGS,
      agentDefaultEnv: YOLO_TUI_AGENT_ENV
    })

    expect(
      resolveAgentPermissionModeSummary({
        ...applied,
        agentDefaultArgs: { ...applied.agentDefaultArgs, claude: '' }
      })
    ).toBe('mixed')
  })

  it('keeps unsupported manual fallbacks inside the auto summary', () => {
    const applied = applyAgentPermissionMode({
      mode: 'auto',
      agentDefaultArgs: YOLO_TUI_AGENT_ARGS,
      agentDefaultEnv: YOLO_TUI_AGENT_ENV
    })

    expect(applied.agentDefaultArgs.copilot).toBe('')
    expect(resolveAgentPermissionModeSummary(applied)).toBe('auto')
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

  it('classifies whitespace-decorated presets as mixed', () => {
    expect(
      resolveTuiAgentPermissionMode({
        agent: 'claude',
        agentArgs: ` ${YOLO_TUI_AGENT_ARGS.claude}`,
        agentEnv: {}
      })
    ).toBe('mixed')
    expect(
      resolveTuiAgentPermissionMode({
        agent: 'codex',
        agentArgs: `${AUTO_TUI_AGENT_ARGS.codex} `,
        agentEnv: {}
      })
    ).toBe('mixed')
    expect(resolveTuiAgentPermissionMode({ agent: 'codex', agentArgs: '   ' })).toBe('mixed')
  })

  it('uses current vendor auto flags for Antigravity and Qwen Code', () => {
    expect(AUTO_TUI_AGENT_ARGS.antigravity).toBe('--mode=accept-edits')
    expect(AUTO_TUI_AGENT_ARGS['qwen-code']).toBe('--approval-mode auto')
  })

  it('projects Auto settings as Manual for legacy clients', () => {
    const applied = applyAgentPermissionMode({
      mode: 'auto',
      agentDefaultArgs: { ...YOLO_TUI_AGENT_ARGS, opencode: '--model custom' },
      agentDefaultEnv: YOLO_TUI_AGENT_ENV
    })

    expect(hasAutoAgentPermissionPreset(applied)).toBe(true)
    const projected = projectAgentPermissionSettingsForLegacyClient(applied)
    expect(resolveAgentPermissionModeSummary(projected)).toBe('manual')
    expect(projected.agentDefaultArgs.opencode).toBe('--model custom')
  })

  it('does not project settings that contain no Auto preset', () => {
    const projected = projectAgentPermissionSettingsForLegacyClient({
      agentDefaultArgs: YOLO_TUI_AGENT_ARGS,
      agentDefaultEnv: YOLO_TUI_AGENT_ENV
    })

    expect(projected.agentDefaultArgs).toEqual(YOLO_TUI_AGENT_ARGS)
    expect(projected.agentDefaultEnv).toEqual(YOLO_TUI_AGENT_ENV)
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

  it('resolves env-driven goose auto launches as auto', () => {
    expect(
      resolveTuiAgentPermissionMode({
        agent: 'goose',
        agentArgs: '',
        agentEnv: AUTO_TUI_AGENT_ENV.goose
      })
    ).toBe('auto')
  })

  it('classifies each new vendor auto-arg harness as auto', () => {
    const agents = [
      'claude-agent-teams',
      'openclaude',
      'antigravity',
      'gemini',
      'qwen-code',
      'devin'
    ] as const
    for (const agent of agents) {
      expect(
        resolveTuiAgentPermissionMode({
          agent,
          agentArgs: AUTO_TUI_AGENT_ARGS[agent],
          agentEnv: {}
        })
      ).toBe('auto')
    }
  })

  it('treats yolo and auto as auto-approving permission modes', () => {
    expect(isAutoApprovingPermissionMode('yolo')).toBe(true)
    expect(isAutoApprovingPermissionMode('auto')).toBe(true)
    expect(isAutoApprovingPermissionMode('manual')).toBe(false)
    expect(isAutoApprovingPermissionMode('mixed')).toBe(false)
  })
})
