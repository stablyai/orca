import { describe, expect, it } from 'vitest'
import { getTuiAgentDetectCommands, TUI_AGENT_CONFIG } from '../catalog/tui-agent-config'
import { buildAgentDraftLaunchPlan, buildAgentStartupPlan } from './tui-agent-startup'

describe('gajae-code startup', () => {
  it('keeps gajae-code on the cursor-gated paste draft route', () => {
    expect(TUI_AGENT_CONFIG['gajae-code'].draftPasteReadySignal).toBe(
      'render-cursor-after-bracketed-paste'
    )
    expect(TUI_AGENT_CONFIG['gajae-code'].draftPromptFlag).toBeUndefined()
    expect(TUI_AGENT_CONFIG['gajae-code'].draftPromptEnvVar).toBeUndefined()
    expect(
      buildAgentDraftLaunchPlan({
        agent: 'gajae-code',
        draft: 'x',
        cmdOverrides: {},
        platform: 'darwin'
      })
    ).toBeNull()
  })

  it('launches Gajae Code through gjc --prompt', () => {
    const plan = buildAgentStartupPlan({
      agent: 'gajae-code',
      prompt: 'fix it',
      cmdOverrides: {},
      platform: 'linux'
    })

    expect(plan).toMatchObject({
      agent: 'gajae-code',
      launchCommand: "gjc --prompt 'fix it'",
      expectedProcess: 'gjc',
      followupPrompt: null,
      launchConfig: { agentCommand: 'gjc', agentArgs: '', agentEnv: {} }
    })
  })

  it('maps Gajae Code detection onto both gjc and gajae-code', () => {
    expect(TUI_AGENT_CONFIG['gajae-code']).toMatchObject({
      detectCmd: 'gjc',
      detectCmdAliases: ['gajae-code'],
      launchCmd: 'gjc',
      expectedProcess: 'gjc',
      promptInjectionMode: 'flag-prompt',
      draftPasteReadySignal: 'render-cursor-after-bracketed-paste'
    })
    expect(getTuiAgentDetectCommands(TUI_AGENT_CONFIG['gajae-code'])).toEqual(['gjc', 'gajae-code'])
  })
})
