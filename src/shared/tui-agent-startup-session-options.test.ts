import { describe, expect, it } from 'vitest'
import {
  buildAgentDraftLaunchPlan,
  buildAgentResumeStartupPlan,
  buildAgentStartupPlan
} from './tui-agent-startup'

describe('tui agent startup session options', () => {
  it('emits catalog options before user arguments without recording an overridden model', () => {
    const plan = buildAgentStartupPlan({
      agent: 'claude',
      prompt: '',
      cmdOverrides: {},
      platform: 'linux',
      allowEmptyPromptLaunch: true,
      sessionOptions: { model: 'opus', effort: 'xhigh', fastMode: true },
      agentArgs: '--model haiku'
    })
    expect(plan?.launchCommand).toBe("claude '--model' 'opus' '--effort' 'xhigh' '--model' 'haiku'")
    expect(plan?.sessionOptions).toBeUndefined()
  })

  it('keeps the model record but drops an effort overridden by user arguments', () => {
    const plan = buildAgentStartupPlan({
      agent: 'claude',
      prompt: '',
      cmdOverrides: {},
      platform: 'linux',
      allowEmptyPromptLaunch: true,
      sessionOptions: { model: 'opus', effort: 'xhigh' },
      agentArgs: '--effort low'
    })
    expect(plan?.sessionOptions).toEqual({ model: 'opus' })
  })

  it('recognizes a long Codex model flag overriding the generated short flag', () => {
    const plan = buildAgentStartupPlan({
      agent: 'codex',
      prompt: '',
      cmdOverrides: {},
      platform: 'linux',
      allowEmptyPromptLaunch: true,
      sessionOptions: { model: 'gpt-5.6-sol', effort: 'medium' },
      agentArgs: '--model gpt-5.5'
    })
    expect(plan?.sessionOptions).toBeUndefined()
  })

  it('keeps one-time picker flags out of the command captured for resume', () => {
    const plan = buildAgentStartupPlan({
      agent: 'codex',
      prompt: '',
      cmdOverrides: {},
      platform: 'linux',
      allowEmptyPromptLaunch: true,
      sessionOptions: { model: 'gpt-5.6-sol', effort: 'medium' },
      agentArgs: '--dangerously-bypass-approvals-and-sandbox'
    })
    expect(plan?.launchConfig.agentCommand).toBe(
      "codex '--dangerously-bypass-approvals-and-sandbox'"
    )
  })

  it('quotes option values for a remote POSIX launch', () => {
    const plan = buildAgentStartupPlan({
      agent: 'claude',
      prompt: '',
      cmdOverrides: {},
      platform: 'linux',
      isRemote: true,
      allowEmptyPromptLaunch: true,
      sessionOptions: { model: "team's-model", effort: 'high' }
    })
    expect(plan?.launchCommand).toContain("'team'\\''s-model'")
  })

  it('threads options through native draft launches', () => {
    const plan = buildAgentDraftLaunchPlan({
      agent: 'claude',
      draft: 'review this',
      cmdOverrides: {},
      platform: 'linux',
      sessionOptions: { model: 'opus', effort: 'high' }
    })
    expect(plan?.launchCommand).toContain("claude '--model' 'opus' '--effort' 'high'")
    expect(plan?.sessionOptions).toEqual({ model: 'opus', effort: 'high' })
  })

  it('never injects session options into resume commands', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'codex',
      providerSession: { key: 'session_id', id: 'thread-1' },
      cmdOverrides: {},
      platform: 'linux',
      sessionOptions: { model: 'gpt-5.5', effort: 'high' }
    })
    expect(plan?.launchCommand).toBe("codex 'resume' 'thread-1'")
    expect(plan?.sessionOptions).toBeUndefined()
  })
})
