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

  it('drives the IBM Bob yolo profile from the chat --auto-approve flag', () => {
    // Why: Bob Shell 2.x deprecated `--yolo`; `--auto-approve` is the `bob chat` equivalent.
    expect(YOLO_TUI_AGENT_ARGS.bob).toBe('--auto-approve')
    expect(
      resolveTuiAgentPermissionMode({ agent: 'bob', agentArgs: '--auto-approve', agentEnv: {} })
    ).toBe('yolo')
    expect(resolveTuiAgentPermissionMode({ agent: 'bob', agentArgs: '', agentEnv: {} })).toBe(
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
