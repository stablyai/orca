import { describe, expect, it } from 'vitest'
import {
  buildAgentDraftLaunchPlan,
  buildAgentResumeStartupPlan,
  buildAgentStartupPlan
} from './tui-agent-startup'
import { resolveAgentLaunchCommand } from './tui-agent-launch-command'

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

  it('lets explicit worker preferences override general agent arguments', () => {
    const plan = buildAgentStartupPlan({
      agent: 'codex',
      prompt: '',
      cmdOverrides: {},
      platform: 'linux',
      allowEmptyPromptLaunch: true,
      sessionOptions: { model: 'custom-codex-model', effort: 'high' },
      sessionOptionsOverrideAgentArgs: true,
      agentArgs: '-m gpt-5.5 -c model_reasoning_effort=low'
    })
    expect(plan?.launchCommand).toBe(
      "codex '-m' 'custom-codex-model' '-c' 'model_reasoning_effort=high'"
    )
    expect(plan?.launchConfig.agentCommand).toBe(
      "codex '-m' 'gpt-5.5' '-c' 'model_reasoning_effort=low'"
    )
    expect(plan?.sessionOptions).toEqual({ model: 'custom-codex-model', effort: 'high' })
  })

  it('inserts worker preferences before an argument terminator', () => {
    const plan = buildAgentStartupPlan({
      agent: 'codex',
      prompt: '',
      cmdOverrides: {},
      platform: 'linux',
      allowEmptyPromptLaunch: true,
      sessionOptions: { model: 'custom-codex-model', effort: 'high' },
      sessionOptionsOverrideAgentArgs: true,
      agentArgs: '--dangerously-bypass-approvals-and-sandbox -- literal'
    })
    expect(plan?.launchCommand).toBe(
      "codex '--dangerously-bypass-approvals-and-sandbox' '-m' 'custom-codex-model' '-c' 'model_reasoning_effort=high' '--' 'literal'"
    )
  })

  it('rejects conflicting singleton flags in an agent command override', () => {
    expect(
      resolveAgentLaunchCommand({
        agent: 'codex',
        cmdOverrides: { codex: 'codex --profile work -m gpt-5.5' },
        platform: 'linux',
        shell: 'posix',
        sessionOptions: { model: 'custom-codex-model', effort: 'high' },
        sessionOptionsOverrideAgentArgs: true
      })
    ).toEqual({
      ok: false,
      error:
        'Agent command override conflicts with the requested launch preferences. Remove model or effort flags from the command override.'
    })
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
