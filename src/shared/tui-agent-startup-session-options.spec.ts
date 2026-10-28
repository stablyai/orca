import { describe, expect, it } from 'vitest'
import {
  buildAgentDraftLaunchPlan,
  buildAgentResumeStartupPlan,
  buildAgentStartupPlan
} from './tui-agent-startup'
import { resolveAgentLaunchCommand } from './tui-agent-launch-command'

describe('tui agent startup session options', () => {
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
    expect(plan?.launchConfig).toMatchObject({ agentCommand: 'codex', agentArgs: '' })
    expect(plan?.sessionOptions).toEqual({ model: 'custom-codex-model', effort: 'high' })
  })

  it('keeps OpenCode agent arguments while replacing only the per-launch model', () => {
    const plan = buildAgentStartupPlan({
      agent: 'opencode',
      prompt: '',
      cmdOverrides: {},
      platform: 'linux',
      allowEmptyPromptLaunch: true,
      sessionOptions: { model: 'zai-coding-plan/glm-5.3-flash' },
      sessionOptionsOverrideAgentArgs: true,
      agentArgs: '--share --model opencode/global-default'
    })
    expect(plan?.launchCommand).toBe("opencode '--share' '--model' 'zai-coding-plan/glm-5.3-flash'")
    expect(plan?.launchConfig).toMatchObject({
      agentCommand: "opencode '--share'",
      agentArgs: "'--share'"
    })
    expect(plan?.sessionOptions).toEqual({ model: 'zai-coding-plan/glm-5.3-flash' })
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
        'Agent command override conflicts with the requested launch preferences. Remove model, effort or permission flags from the command override.'
    })
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
    expect(plan?.launchCommand).toContain(`'team'"'"'s-model'`)
  })

  it('lets explicit worker preferences override configured arguments in draft launches', () => {
    const plan = buildAgentDraftLaunchPlan({
      agent: 'claude',
      draft: 'review this',
      cmdOverrides: {},
      platform: 'linux',
      agentArgs: '--model haiku --effort low',
      sessionOptions: { model: 'opus', effort: 'high' },
      sessionOptionsOverrideAgentArgs: true
    })

    expect(plan?.launchCommand).toContain(
      "claude '--model' 'opus' '--effort' 'high' --prefill 'review this'"
    )
    expect(plan?.launchCommand).not.toContain('haiku')
    expect(plan?.launchCommand).not.toContain("'low'")
  })

  it('applies explicit session options to resume commands', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'codex',
      providerSession: { key: 'session_id', id: 'thread-1' },
      cmdOverrides: {},
      platform: 'linux',
      agentArgs: '-m gpt-5.6-sol -c model_reasoning_effort=medium',
      sessionOptions: { model: 'gpt-5.5', effort: 'high' },
      sessionOptionsOverrideAgentArgs: true
    })
    expect(plan?.launchCommand).toBe(
      "codex '-m' 'gpt-5.5' '-c' 'model_reasoning_effort=high' 'resume' 'thread-1'"
    )
    expect(plan?.launchConfig).toMatchObject({ agentCommand: 'codex', agentArgs: '' })
    expect(plan?.sessionOptions).toEqual({ model: 'gpt-5.5', effort: 'high' })
  })
})
