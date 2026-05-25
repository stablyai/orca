import { describe, expect, it } from 'vitest'
import { buildTerminalAgentQuickCommandPreset } from './terminal-agent-quick-command-presets'

describe('terminal agent quick command presets', () => {
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
