import { describe, expect, it } from 'vitest'
import { buildAgentDraftLaunchPlan, buildAgentStartupPlan } from './tui-agent-startup'
import type { CustomTuiAgent } from '../../../shared/types'

const sampleCustom: CustomTuiAgent = {
  id: 'custom:my-wrapper-abc123',
  label: 'My Wrapper',
  command: 'npx -y my-wrapper',
  promptInjectionMode: 'stdin-after-start'
}

describe('buildAgentStartupPlan with custom agents', () => {
  it('uses the custom agent command on the followup path', () => {
    expect(
      buildAgentStartupPlan({
        agent: sampleCustom.id,
        prompt: 'Review the PR',
        cmdOverrides: {},
        customTuiAgents: [sampleCustom],
        platform: 'darwin'
      })
    ).toEqual({
      agent: sampleCustom.id,
      launchCommand: 'npx -y my-wrapper',
      expectedProcess: 'npx',
      followupPrompt: 'Review the PR'
    })
  })

  it('respects agentCmdOverrides for a custom agent id', () => {
    expect(
      buildAgentStartupPlan({
        agent: sampleCustom.id,
        prompt: '',
        cmdOverrides: { [sampleCustom.id]: 'my-wrapper --debug' },
        customTuiAgents: [sampleCustom],
        platform: 'darwin',
        allowEmptyPromptLaunch: true
      })
    ).toEqual({
      agent: sampleCustom.id,
      launchCommand: 'my-wrapper --debug',
      expectedProcess: 'npx',
      followupPrompt: null
    })
  })

  it('returns null for an unknown custom id not in the list', () => {
    expect(
      buildAgentStartupPlan({
        agent: 'custom:missing-zzz999',
        prompt: 'anything',
        cmdOverrides: {},
        customTuiAgents: [],
        platform: 'darwin'
      })
    ).toBeNull()
  })
})

describe('buildAgentDraftLaunchPlan with custom agents', () => {
  it('returns null for custom agents (no native prefill in v1)', () => {
    expect(
      buildAgentDraftLaunchPlan({
        agent: sampleCustom.id,
        draft: 'review this',
        cmdOverrides: {},
        customTuiAgents: [sampleCustom],
        platform: 'darwin'
      })
    ).toBeNull()
  })
})
