import { describe, expect, it } from 'vitest'
import { tuiAgentToAgentKind } from './agent-kind'
import { SKILLS_CLI_AGENT_KEY_BY_TUI_AGENT } from './skills-cli-agent-keys'
import { TUI_AGENT_DISPLAY_NAMES } from './tui-agent-display-names'
import { getTuiAgentLaunchCommand, isTuiAgent, TUI_AGENT_CONFIG } from './tui-agent-config'
import { TUI_AGENT_AUTO_PICK_ORDER } from './tui-agent-selection'

// Why: Gajae Code launches as a plain interactive TUI on `gjc`, so the only thing
// that can silently break it is a half-finished registration (union member with no
// config, or a config the auto-pick order never reaches).
describe('Gajae Code agent registration', () => {
  it('detects and launches the published `gjc` binary', () => {
    expect(isTuiAgent('gjc')).toBe(true)
    const config = TUI_AGENT_CONFIG.gjc
    expect(config.detectCmd).toBe('gjc')
    expect(getTuiAgentLaunchCommand(config, 'darwin')).toBe('gjc')
    expect(config.expectedProcess).toBe('gjc')
  })

  it('injects the launch prompt after startup instead of as argv', () => {
    // Why: `gjc -p <prompt>` is its non-interactive print mode, and it exposes no
    // prefill flag or env var, so argv/flag injection would exit the hosted session.
    expect(TUI_AGENT_CONFIG.gjc.promptInjectionMode).toBe('stdin-after-start')
    expect(TUI_AGENT_CONFIG.gjc.draftPromptFlag).toBeUndefined()
    expect(TUI_AGENT_CONFIG.gjc.draftPromptEnvVar).toBeUndefined()
  })

  it('is selectable, labelled, and telemetry-mapped', () => {
    expect(TUI_AGENT_DISPLAY_NAMES.gjc).toBe('Gajae Code')
    expect(TUI_AGENT_AUTO_PICK_ORDER).toContain('gjc')
    expect(tuiAgentToAgentKind('gjc')).toBe('gjc')
  })

  it('claims no skills CLI agent key', () => {
    // Why: the community skills CLI exits 1 on an unknown --agent value, and it has
    // no gjc key; Gajae Code reads its own .gjc roots plus shared .agents/skills.
    expect(SKILLS_CLI_AGENT_KEY_BY_TUI_AGENT.gjc).toBeNull()
  })
})
