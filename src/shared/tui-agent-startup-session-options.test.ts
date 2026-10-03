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

  it('places transient arguments before the terminator without persisting them', () => {
    const plan = buildAgentStartupPlan({
      agent: 'codex',
      prompt: '',
      cmdOverrides: {},
      platform: 'linux',
      allowEmptyPromptLaunch: true,
      agentArgs: '--dangerously-bypass-approvals-and-sandbox -- literal',
      transientAgentArgs: ['-c', 'check_for_update_on_startup=false']
    })

    expect(plan?.launchCommand).toBe(
      "codex '--dangerously-bypass-approvals-and-sandbox' '-c' 'check_for_update_on_startup=false' '--' 'literal'"
    )
    expect(plan?.launchConfig.agentCommand).toBe(
      "codex '--dangerously-bypass-approvals-and-sandbox' '--' 'literal'"
    )
  })

  it('places transient arguments before a terminator carried by the command override', () => {
    const plan = buildAgentStartupPlan({
      agent: 'codex',
      prompt: '',
      cmdOverrides: { codex: 'codex --profile work -- literal' },
      platform: 'linux',
      allowEmptyPromptLaunch: true,
      transientAgentArgs: ['-c', 'check_for_update_on_startup=false']
    })

    expect(plan?.launchCommand).toBe(
      "codex --profile work '-c' 'check_for_update_on_startup=false' -- literal"
    )
    expect(plan?.launchConfig.agentCommand).toBe('codex --profile work -- literal')
  })

  it('leaves an override that wraps the agent intact when splicing transient arguments', () => {
    const plan = buildAgentStartupPlan({
      agent: 'codex',
      prompt: '',
      cmdOverrides: { codex: 'CODEX_HOME=/tmp/x uv run codex -- literal' },
      platform: 'linux',
      allowEmptyPromptLaunch: true,
      transientAgentArgs: ['-c', 'check_for_update_on_startup=false']
    })

    expect(plan?.launchCommand).toBe(
      "CODEX_HOME=/tmp/x uv run codex '-c' 'check_for_update_on_startup=false' -- literal"
    )
  })

  it('appends transient arguments after the agent when the terminator belongs to a wrapper', () => {
    const plan = buildAgentStartupPlan({
      agent: 'codex',
      prompt: '',
      cmdOverrides: { codex: 'mise exec -- codex' },
      platform: 'linux',
      allowEmptyPromptLaunch: true,
      transientAgentArgs: ['-c', 'check_for_update_on_startup=false']
    })

    expect(plan?.launchCommand).toBe("mise exec -- codex '-c' 'check_for_update_on_startup=false'")
  })

  it('splices before the agent terminator, not the wrapper terminator ahead of it', () => {
    const plan = buildAgentStartupPlan({
      agent: 'codex',
      prompt: '',
      cmdOverrides: { codex: 'mise exec -- codex --profile work -- literal' },
      platform: 'linux',
      allowEmptyPromptLaunch: true,
      transientAgentArgs: ['-c', 'check_for_update_on_startup=false']
    })

    expect(plan?.launchCommand).toBe(
      "mise exec -- codex --profile work '-c' 'check_for_update_on_startup=false' -- literal"
    )
    expect(plan?.launchConfig.agentCommand).toBe('mise exec -- codex --profile work -- literal')
  })

  it('does not mistake an argument ending in the agent name for the executable', () => {
    const plan = buildAgentStartupPlan({
      agent: 'codex',
      prompt: '',
      cmdOverrides: { codex: 'ssh -i ~/.ssh/codex devbox -- codex' },
      platform: 'linux',
      allowEmptyPromptLaunch: true,
      transientAgentArgs: ['-c', 'check_for_update_on_startup=false']
    })

    expect(plan?.launchCommand).toBe(
      "ssh -i ~/.ssh/codex devbox -- codex '-c' 'check_for_update_on_startup=false'"
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
