import { describe, expect, it } from 'vitest'
import {
  resolveAgentStartupPlanInputs,
  type AgentStartupSettings
} from './agent-startup-plan-inputs'
import { buildAgentStartupPlan } from './tui-agent-startup'

describe('a picked session option outranks configured launch arguments', () => {
  // Compose the surfaces: prove one model flag reaches argv and the chat can name the selected model, beyond asserting the policy flag.
  function commandFor(settings: AgentStartupSettings) {
    return buildAgentStartupPlan({
      ...resolveAgentStartupPlanInputs({
        agent: 'codex',
        settings,
        platform: 'darwin',
        isRemote: false,
        shell: undefined,
        sessionOptions: { model: 'gpt-5' }
      }),
      prompt: '',
      allowEmptyPromptLaunch: true
    })
  }

  it('strips the configured model flag instead of emitting both spellings', () => {
    const plan = commandFor({ agentDefaultArgs: { codex: '--model gpt-5-codex' } })

    expect(plan?.launchCommand).toBe("codex '-c' 'disable_paste_burst=true' '-m' 'gpt-5'")
  })
})

it('projects own permission without dropping unrelated arguments, model or environment on terminal fallback', () => {
  const inputs = resolveAgentStartupPlanInputs({
    agent: 'codex',
    settings: {
      agentPermissionDefault: 'full-access',
      agentDefaultArgs: { codex: '--search' },
      agentDefaultEnv: { codex: { KEEP: 'value' } }
    },
    platform: 'linux',
    isRemote: false,
    shell: 'posix',
    sessionOptions: { permissionMode: 'own', model: 'gpt-5.5' }
  })
  const plan = buildAgentStartupPlan({ ...inputs, prompt: '', allowEmptyPromptLaunch: true })
  expect(plan?.launchCommand).toContain("'--search'")
  expect(plan?.launchCommand).toContain("'-m' 'gpt-5.5'")
  expect(plan?.launchCommand).not.toContain('bypass')
  expect(plan?.env).toEqual({ KEEP: 'value' })
  expect(plan?.sessionOptions?.permissionMode).toBe('own')
})

it('keeps a terminal-only choice with explicit blank args and projects its flag once on a legacy launch', () => {
  const inputs = resolveAgentStartupPlanInputs({
    agent: 'gemini',
    settings: { agentDefaultArgs: { gemini: '--debug' } },
    agentArgs: '',
    platform: 'win32',
    isRemote: true,
    shell: 'powershell',
    sessionOptions: { permissionMode: 'full-access' }
  })
  const plan = buildAgentStartupPlan({ ...inputs, prompt: '', allowEmptyPromptLaunch: true })
  expect(plan?.launchConfig.agentArgs).not.toContain('--debug')
  expect(plan?.launchConfig.agentArgs.match(/--yolo/g)).toHaveLength(1)
  expect(plan?.sessionOptions?.permissionMode).toBe('full-access')
  const legacy = buildAgentStartupPlan({
    ...inputs,
    agentArgs: plan?.launchConfig.agentArgs,
    sessionOptions: undefined,
    prompt: '',
    allowEmptyPromptLaunch: true
  })
  expect(legacy?.launchCommand.match(/--yolo/g)).toHaveLength(1)
})
