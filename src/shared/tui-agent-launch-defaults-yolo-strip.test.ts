import { describe, expect, it } from 'vitest'
import {
  stripYoloTuiAgentLaunchArgs,
  stripYoloTuiAgentLaunchCommand,
  stripYoloTuiAgentLaunchEnv
} from './tui-agent-launch-defaults'
import { YOLO_TUI_AGENT_ARGS } from './tui-agent-permissions'
import type { AgentStartupShell } from './tui-agent-startup-shell'
import type { TuiAgent } from './tui-agent'

const YOLO_AGENTS = Object.entries(YOLO_TUI_AGENT_ARGS) as [TuiAgent, string][]
const SHELLS: AgentStartupShell[] = ['posix', 'powershell', 'cmd']

describe('stripping permission-bypass launch defaults', () => {
  it('removes the agent bypass flag and keeps every other argument', () => {
    expect(
      stripYoloTuiAgentLaunchArgs('claude', '--dangerously-skip-permissions --model opus')
    ).toBe('--model opus')
    expect(
      stripYoloTuiAgentLaunchArgs('codex', '--dangerously-bypass-approvals-and-sandbox -m gpt-5.4')
    ).toBe('-m gpt-5.4')
  })

  it('removes a multi-token bypass form whole', () => {
    expect(stripYoloTuiAgentLaunchArgs('grok', '--permission-mode bypassPermissions --fast')).toBe(
      '--fast'
    )
  })

  it('removes a multi-token bypass with shell-equivalent whitespace', () => {
    expect(
      stripYoloTuiAgentLaunchArgs('grok', '--permission-mode   bypassPermissions --fast')
    ).toBe('--fast')
  })

  it('removes quoted bypass tokens with the same shell meaning', () => {
    expect(
      stripYoloTuiAgentLaunchArgs('claude', "'--dangerously-skip-permissions' --model opus")
    ).toBe('--model opus')
    expect(
      stripYoloTuiAgentLaunchArgs('grok', "--permission-mode 'bypassPermissions' --fast")
    ).toBe('--fast')
  })

  it('removes a bypass form whose configured value is itself quoted', () => {
    // `YOLO_TUI_AGENT_ARGS.continue` is `--allow "*"`; the launch path tokenizes it to
    // `--allow`, `*`, so comparing against a whitespace split would never match.
    expect(stripYoloTuiAgentLaunchArgs('continue', '--allow "*" --model sonnet')).toBe(
      '--model sonnet'
    )
    expect(stripYoloTuiAgentLaunchArgs('continue', "--allow '*'")).toBe('')
  })

  it('removes a quoted bypass form from a command override on every shell', () => {
    for (const shell of SHELLS) {
      expect(stripYoloTuiAgentLaunchCommand('continue', 'continue --allow "*"', shell)).toBe(
        'continue'
      )
    }
    expect(
      stripYoloTuiAgentLaunchCommand('continue', 'my-continue --tui --allow "*"', 'powershell')
    ).toBe('my-continue --tui')
  })

  it.each(SHELLS)('strips every configured bypass form whole on %s', (shell) => {
    for (const [agent, yoloArgs] of YOLO_AGENTS) {
      expect([agent, stripYoloTuiAgentLaunchArgs(agent, yoloArgs, shell)]).toEqual([agent, ''])
      expect([agent, stripYoloTuiAgentLaunchCommand(agent, `${agent} ${yoloArgs}`, shell)]).toEqual(
        [agent, agent]
      )
    }
  })

  it('leaves a non-bypass argument that merely shares a prefix', () => {
    expect(stripYoloTuiAgentLaunchArgs('claude', '--dangerously-skip-permissions-not-really')).toBe(
      '--dangerously-skip-permissions-not-really'
    )
    expect(stripYoloTuiAgentLaunchArgs('continue', '--allow "**"')).toBe('--allow "**"')
  })

  it('is a no-op for an agent with no bypass flag', () => {
    expect(stripYoloTuiAgentLaunchArgs('opencode', '--session abc')).toBe('--session abc')
  })

  // Reachability note: no agent in RESUMABLE_TUI_AGENTS currently has an env-based bypass
  // profile, so the resume path's env strip is inert today. The helper is the generic
  // counterpart of the args strip and is exercised here on the one agent that has one.
  it('removes only env names the agent bypass profile sets to that exact value', () => {
    expect(stripYoloTuiAgentLaunchEnv('goose', { GOOSE_MODE: 'auto', OTHER: 'keep' })).toEqual({
      OTHER: 'keep'
    })
    expect(stripYoloTuiAgentLaunchEnv('goose', { GOOSE_MODE: 'approve' })).toEqual({
      GOOSE_MODE: 'approve'
    })
    expect(stripYoloTuiAgentLaunchEnv('claude', { ANTHROPIC_MODEL: 'opus' })).toEqual({
      ANTHROPIC_MODEL: 'opus'
    })
  })
})
