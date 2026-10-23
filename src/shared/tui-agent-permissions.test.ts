import { describe, expect, it } from 'vitest'
import {
  applyAgentPermissionMode,
  resolveAgentPermissionModeSummary,
  resolveNonAutoAgentPermissionMode,
  resolveTuiAgentPermissionMode,
  AUTO_TUI_AGENT_ARGS,
  YOLO_TUI_AGENT_ARGS,
  YOLO_TUI_AGENT_ENV
} from './tui-agent-permissions'

describe('tui agent permissions', () => {
  it.each(['yolo', 'manual'] as const)(
    'applies auto to supporting agents while preserving the %s policy elsewhere',
    (mode) => {
      const previous = applyAgentPermissionMode({ mode })
      const automatic = applyAgentPermissionMode({ mode: 'auto', ...previous })

      expect(automatic.agentDefaultArgs).toMatchObject(AUTO_TUI_AGENT_ARGS)
      expect(automatic.agentDefaultArgs.gemini).toBe(previous.agentDefaultArgs.gemini)
      expect(automatic.agentDefaultEnv).toEqual(previous.agentDefaultEnv)
      expect(resolveAgentPermissionModeSummary(automatic)).toBe('auto')
      expect(applyAgentPermissionMode({ mode, ...automatic })).toEqual(previous)
    }
  )

  it('recognizes manually configured auto arguments for each supporting agent', () => {
    for (const agent of ['claude', 'claude-agent-teams', 'codex'] as const) {
      expect(resolveTuiAgentPermissionMode({ agent, agentArgs: AUTO_TUI_AGENT_ARGS[agent] })).toBe(
        'auto'
      )
    }
  })

  it('preserves custom arguments and leaves them out of the Auto summary', () => {
    const automatic = applyAgentPermissionMode({
      mode: 'auto',
      agentDefaultArgs: { claude: '--model sonnet' }
    })
    expect(automatic.agentDefaultArgs.claude).toBe('--model sonnet')
    expect(automatic.agentDefaultArgs.codex).toBe('--approve-for-me')
    expect(resolveAgentPermissionModeSummary(automatic)).toBe('auto')
  })

  it('keeps an Auto profile Auto when an unsupported agent has custom arguments', () => {
    const automatic = applyAgentPermissionMode({
      mode: 'auto',
      agentDefaultArgs: { ...YOLO_TUI_AGENT_ARGS, gemini: '--model custom' },
      agentDefaultEnv: YOLO_TUI_AGENT_ENV
    })
    expect(resolveAgentPermissionModeSummary(automatic)).toBe('auto')
    expect(resolveNonAutoAgentPermissionMode(automatic)).toBe('yolo')
  })

  it('does not call a profile Auto when every Auto-capable agent has custom arguments', () => {
    expect(
      resolveAgentPermissionModeSummary({
        agentDefaultArgs: {
          claude: '--model a',
          'claude-agent-teams': '--model b',
          codex: '--model c'
        }
      })
    ).toBe('manual')
  })

  it('reports the agents Auto does not cover as mixed only when their presets differ', () => {
    const automatic = applyAgentPermissionMode({
      mode: 'auto',
      ...applyAgentPermissionMode({ mode: 'yolo' })
    })
    expect(resolveNonAutoAgentPermissionMode(automatic)).toBe('yolo')
    expect(
      resolveNonAutoAgentPermissionMode({
        ...automatic,
        agentDefaultArgs: { ...automatic.agentDefaultArgs, gemini: '' }
      })
    ).toBe('mixed')
  })

  it('reports no single mode when every agent Auto does not cover has custom arguments', () => {
    const automatic = applyAgentPermissionMode({ mode: 'auto' })
    const custom = Object.fromEntries(
      Object.keys(YOLO_TUI_AGENT_ARGS)
        .filter((agent) => !(agent in AUTO_TUI_AGENT_ARGS))
        .map((agent) => [agent, '--custom-flag'])
    )
    expect(
      resolveNonAutoAgentPermissionMode({
        agentDefaultArgs: { ...automatic.agentDefaultArgs, ...custom },
        agentDefaultEnv: { goose: { GOOSE_MODE: 'custom' } }
      })
    ).toBe('mixed')
  })

  it('changes only agents Auto does not cover when asked to', () => {
    const automatic = applyAgentPermissionMode({
      mode: 'auto',
      ...applyAgentPermissionMode({ mode: 'yolo' })
    })
    const manualOthers = applyAgentPermissionMode({
      mode: 'manual',
      exceptAuto: true,
      ...automatic
    })
    expect(manualOthers.agentDefaultArgs).toMatchObject(AUTO_TUI_AGENT_ARGS)
    expect(manualOthers.agentDefaultArgs.gemini).toBe('')
    expect(manualOthers.agentDefaultEnv.goose).toEqual({})
    expect(resolveAgentPermissionModeSummary(manualOthers)).toBe('auto')
    expect(resolveNonAutoAgentPermissionMode(manualOthers)).toBe('manual')
  })

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

  it('ignores custom arguments when summarizing the shared mode', () => {
    expect(
      resolveAgentPermissionModeSummary({
        agentDefaultArgs: {
          ...YOLO_TUI_AGENT_ARGS,
          codex: '--model gpt-5'
        },
        agentDefaultEnv: YOLO_TUI_AGENT_ENV
      })
    ).toBe('yolo')
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

  it('switches Muse between yolo and manual arguments', () => {
    expect(
      applyAgentPermissionMode({
        mode: 'yolo',
        agentDefaultArgs: { muse: '' },
        agentDefaultEnv: {}
      }).agentDefaultArgs.muse
    ).toBe('--yolo')
    expect(
      applyAgentPermissionMode({
        mode: 'manual',
        agentDefaultArgs: { muse: '--yolo' },
        agentDefaultEnv: {}
      }).agentDefaultArgs.muse
    ).toBe('')
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
