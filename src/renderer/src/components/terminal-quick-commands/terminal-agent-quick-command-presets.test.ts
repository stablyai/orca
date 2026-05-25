import { describe, expect, it } from 'vitest'
import { TUI_AGENT_CONFIG } from '../../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../../shared/types'
import { buildTerminalAgentQuickCommandPreset } from './terminal-agent-quick-command-presets'

describe('terminal agent quick command presets', () => {
  it('matches the supported one-line startup commands for every prompt-starting agent', () => {
    const expectedCommands: Partial<Record<TuiAgent, string>> = {
      claude: "claude 'your prompt here'",
      codex: "codex 'your prompt here'",
      copilot: "copilot -i 'your prompt here'",
      opencode: "opencode --prompt 'your prompt here'",
      pi: "pi 'your prompt here'",
      gemini: "gemini --prompt-interactive 'your prompt here'",
      antigravity: "agy --prompt-interactive 'your prompt here'",
      cursor: "cursor-agent 'your prompt here'",
      droid: "droid 'your prompt here'"
    }

    const promptStartingCommands = Object.keys(TUI_AGENT_CONFIG)
      .map((agent) =>
        buildTerminalAgentQuickCommandPreset({
          agent: agent as TuiAgent,
          label: agent,
          cmdOverrides: {},
          platform: 'linux'
        })
      )
      .filter((preset): preset is NonNullable<typeof preset> => preset?.startsWithPrompt === true)

    expect(
      Object.fromEntries(promptStartingCommands.map((preset) => [preset.agent, preset.command]))
    ).toEqual(expectedCommands)
  })

  it('does not expose post-start paste agents as insertable command templates', () => {
    const insertableAgents = Object.keys(TUI_AGENT_CONFIG).filter((agent) => {
      return (
        buildTerminalAgentQuickCommandPreset({
          agent: agent as TuiAgent,
          label: agent,
          cmdOverrides: {},
          platform: 'linux'
        })?.startsWithPrompt === true
      )
    })

    expect(insertableAgents).not.toContain('aider')
    expect(insertableAgents).not.toContain('goose')
    expect(insertableAgents).not.toContain('amp')
    expect(insertableAgents).not.toContain('qwen-code')
  })

  it('builds prompt-starting commands for argv agents', () => {
    expect(
      buildTerminalAgentQuickCommandPreset({
        agent: 'claude',
        label: 'Claude',
        cmdOverrides: {},
        platform: 'darwin'
      })
    ).toEqual({
      agent: 'claude',
      label: 'Claude',
      command: "claude 'your prompt here'",
      startsWithPrompt: true
    })
  })

  it('uses interactive prompt flags when the agent requires them', () => {
    expect(
      buildTerminalAgentQuickCommandPreset({
        agent: 'gemini',
        label: 'Gemini',
        cmdOverrides: {},
        platform: 'linux'
      })?.command
    ).toBe("gemini --prompt-interactive 'your prompt here'")
  })

  it('marks post-start paste agents as launch-only', () => {
    expect(
      buildTerminalAgentQuickCommandPreset({
        agent: 'aider',
        label: 'Aider',
        cmdOverrides: {},
        platform: 'linux'
      })
    ).toEqual({
      agent: 'aider',
      label: 'Aider',
      command: 'aider',
      startsWithPrompt: false
    })
  })

  it('preserves configured command overrides', () => {
    expect(
      buildTerminalAgentQuickCommandPreset({
        agent: 'codex',
        label: 'Codex',
        cmdOverrides: { codex: '/opt/bin/codex' },
        platform: 'linux'
      })?.command
    ).toBe("/opt/bin/codex 'your prompt here'")
  })
})
