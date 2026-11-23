import { describe, expect, it } from 'vitest'
import { resolveAgentStartupPlanInputs } from '../startup/agent-startup-plan-inputs'
import { buildAgentStartupPlan } from '../startup/tui-agent-startup'
import { normalizeCustomTuiAgents } from './custom-tui-agents'

describe('normalizeCustomTuiAgents', () => {
  it('keeps complete entries with a one-line command and drops the rest', () => {
    expect(
      normalizeCustomTuiAgents([
        { id: 'axis', name: ' axis ', agent: 'claude', command: ' claude-axis ' },
        { id: 'aione', name: 'aione', agent: 'claude', command: 'aione launch\nclaude' },
        { id: 'axis', name: 'duplicate id', agent: 'claude', command: 'claude-other' },
        { id: 'nameless', name: '', agent: 'claude', command: 'claude-x' },
        { id: 'unknown', name: 'unknown', agent: 'not-an-agent', command: 'x' },
        { id: 'blank', name: 'blank', agent: 'claude', command: '  ' },
        'not an entry'
      ])
    ).toEqual([
      { id: 'axis', name: 'axis', agent: 'claude', command: 'claude-axis' },
      { id: 'aione', name: 'aione', agent: 'claude', command: 'aione launch claude' }
    ])
    expect(normalizeCustomTuiAgents(undefined)).toEqual([])
  })
})

describe('custom agent launch command override', () => {
  it('replaces the Settings command for that launch and its resume config', () => {
    const plan = buildAgentStartupPlan({
      ...resolveAgentStartupPlanInputs({
        agent: 'claude',
        settings: { agentCmdOverrides: { claude: 'claude-default' } },
        launchCommand: 'aione launch claude',
        platform: 'darwin',
        shell: undefined,
        isRemote: false
      }),
      prompt: '',
      allowEmptyPromptLaunch: true
    })
    expect(plan?.launchCommand).toMatch(/^aione launch claude(\s|$)/)
    expect(plan?.launchConfig.agentCommand).toMatch(/^aione launch claude(\s|$)/)
  })
})
