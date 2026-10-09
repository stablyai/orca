import { describe, expect, it } from 'vitest'
import {
  buildAgentDraftLaunchPlan,
  buildAgentResumeStartupPlan,
  buildAgentStartupPlan
} from './tui-agent-startup'
import { resolveAgentLaunchCommand } from './tui-agent-launch-command'

describe('tui agent startup session options', () => {
  it('sends neither the picked model nor its options when user arguments set the model', () => {
    const plan = buildAgentStartupPlan({
      agent: 'claude',
      prompt: '',
      cmdOverrides: {},
      platform: 'linux',
      allowEmptyPromptLaunch: true,
      sessionOptions: { model: 'opus', effort: 'xhigh', fastMode: true },
      agentArgs: '--model haiku'
    })
    expect(plan?.launchCommand).toBe("claude '--model' 'haiku'")
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

  it('forwards Antigravity worker model and effort without dropping permission defaults', () => {
    const plan = buildAgentStartupPlan({
      agent: 'antigravity',
      prompt: '',
      cmdOverrides: {},
      platform: 'linux',
      allowEmptyPromptLaunch: true,
      sessionOptions: { model: 'gemini-3.1-pro-high', effort: 'high' },
      sessionOptionsOverrideAgentArgs: true,
      agentArgs: '--dangerously-skip-permissions'
    })
    expect(plan?.launchCommand).toBe(
      "agy '--dangerously-skip-permissions' '--model' 'gemini-3.1-pro-high' '--effort' 'high'"
    )
    expect(plan?.launchConfig.agentCommand).toBe("agy '--dangerously-skip-permissions'")
    expect(plan?.sessionOptions).toEqual({ model: 'gemini-3.1-pro-high', effort: 'high' })
  })

  it('forwards Muse worker model and effort after its workspace-trust default', () => {
    const plan = buildAgentStartupPlan({
      agent: 'muse',
      prompt: '',
      cmdOverrides: {},
      platform: 'linux',
      allowEmptyPromptLaunch: true,
      sessionOptions: { model: 'muse-spark-1.3', effort: 'xhigh' },
      sessionOptionsOverrideAgentArgs: true,
      agentArgs: '--model muse-spark-1.2'
    })
    expect(plan?.launchCommand).toBe(
      "muse --trust-workspace '--model' 'muse-spark-1.3' '--reasoning-effort' 'xhigh'"
    )
    expect(plan?.sessionOptions).toEqual({ model: 'muse-spark-1.3', effort: 'xhigh' })
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
    expect(plan?.launchConfig.agentCommand).toBe(
      "opencode '--share' '--model' 'opencode/global-default'"
    )
    expect(plan?.sessionOptions).toEqual({ model: 'zai-coding-plan/glm-5.3-flash' })
  })

  it('launches a Pi worker with a model and thinking level without persisting them', () => {
    const plan = buildAgentStartupPlan({
      agent: 'pi',
      prompt: '',
      cmdOverrides: {},
      platform: 'linux',
      allowEmptyPromptLaunch: true,
      sessionOptions: { model: 'google/gemini-3-pro', effort: 'xhigh' },
      sessionOptionsOverrideAgentArgs: true,
      agentArgs: '--continue'
    })
    expect(plan?.launchCommand).toBe(
      "pi '--continue' '--model' 'google/gemini-3-pro' '--thinking' 'xhigh'"
    )
    expect(plan?.launchConfig.agentCommand).toBe("pi '--continue'")
    expect(plan?.sessionOptions).toEqual({ model: 'google/gemini-3-pro', effort: 'xhigh' })
  })

  it('replaces configured Pi model and thinking args instead of sending the flags twice', () => {
    const plan = buildAgentStartupPlan({
      agent: 'pi',
      prompt: '',
      cmdOverrides: {},
      platform: 'linux',
      allowEmptyPromptLaunch: true,
      sessionOptions: { model: 'google/gemini-3-pro', effort: 'high' },
      sessionOptionsOverrideAgentArgs: true,
      agentArgs: '--model openai-codex/gpt-6-luna --thinking low --continue'
    })
    expect(plan?.launchCommand).toBe(
      "pi '--continue' '--model' 'google/gemini-3-pro' '--thinking' 'high'"
    )
    expect(plan?.sessionOptions).toEqual({ model: 'google/gemini-3-pro', effort: 'high' })
  })

  it('launches a Devin worker model while keeping its configured permission args', () => {
    const plan = buildAgentStartupPlan({
      agent: 'devin',
      prompt: '',
      cmdOverrides: {},
      platform: 'linux',
      allowEmptyPromptLaunch: true,
      sessionOptions: { model: 'swe-2-medium' },
      sessionOptionsOverrideAgentArgs: true,
      agentArgs: '--permission-mode bypass --respect-workspace-trust false --model swe-2-max'
    })
    expect(plan?.launchCommand).toBe(
      "devin '--permission-mode' 'bypass' '--respect-workspace-trust' 'false' '--model' 'swe-2-medium'"
    )
    expect(plan?.sessionOptions).toEqual({ model: 'swe-2-medium' })
  })

  it('sends a Devin model before a prompt terminator', () => {
    const plan = buildAgentStartupPlan({
      agent: 'devin',
      prompt: '',
      cmdOverrides: {},
      platform: 'linux',
      allowEmptyPromptLaunch: true,
      sessionOptions: { model: 'swe-2-medium' },
      sessionOptionsOverrideAgentArgs: true,
      agentArgs: '--permission-mode bypass -- literal prompt'
    })
    expect(plan?.launchCommand).toBe(
      "devin '--permission-mode' 'bypass' '--model' 'swe-2-medium' '--' 'literal' 'prompt'"
    )
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
    expect(plan?.launchCommand).toContain(`'team'"'"'s-model'`)
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
    expect(plan?.launchConfig.agentCommand).toBe(
      "codex '-m' 'gpt-5.6-sol' '-c' 'model_reasoning_effort=medium'"
    )
    expect(plan?.sessionOptions).toEqual({ model: 'gpt-5.5', effort: 'high' })
  })
})
