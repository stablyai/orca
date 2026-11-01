import { describe, expect, it } from 'vitest'
import {
  resolveAgentStartupPlanInputs,
  type AgentStartupSettings
} from './agent-startup-plan-inputs'
import { buildAgentStartupPlan } from './tui-agent-startup'

const EMPTY_SETTINGS: AgentStartupSettings = {}

describe('resolveAgentStartupPlanInputs', () => {
  it('reads the four launch settings and defaults an absent command override map', () => {
    const inputs = resolveAgentStartupPlanInputs({
      agent: 'claude',
      settings: {
        agentCmdOverrides: { claude: 'my-claude' },
        agentDefaultArgs: { claude: '--verbose' },
        agentDefaultEnv: { claude: { FOO: 'bar' } }
      },
      platform: 'darwin',
      isRemote: false,
      shell: undefined
    })

    expect(inputs.cmdOverrides).toEqual({ claude: 'my-claude' })
    expect(inputs.agentArgs).toBe('--verbose')
    expect(inputs.agentEnv).toEqual({ FOO: 'bar' })
    expect(
      resolveAgentStartupPlanInputs({
        agent: 'claude',
        settings: EMPTY_SETTINGS,
        platform: 'darwin',
        isRemote: false,
        shell: undefined
      }).cmdOverrides
    ).toEqual({})
  })

  it('treats an explicit null agentArgs as "no arguments" rather than "use the default"', () => {
    const settings: AgentStartupSettings = { agentDefaultArgs: { claude: '--verbose' } }
    const base = {
      agent: 'claude' as const,
      settings,
      platform: 'darwin' as const,
      isRemote: false,
      shell: undefined
    }

    expect(resolveAgentStartupPlanInputs(base).agentArgs).toBe('--verbose')
    expect(resolveAgentStartupPlanInputs({ ...base, agentArgs: null }).agentArgs).toBeNull()
    expect(resolveAgentStartupPlanInputs({ ...base, agentArgs: '--model opus' }).agentArgs).toBe(
      '--model opus'
    )
  })

  it('classifies the Windows shell only for a local win32 launch', () => {
    const settings: AgentStartupSettings = { terminalWindowsShell: 'git-bash' }

    expect(
      resolveAgentStartupPlanInputs({
        agent: 'claude',
        settings,
        platform: 'win32',
        isRemote: false,
        shell: undefined
      }).shell
    ).toBe('posix')
    // Remote targets need their own shell signal before quoting can be overridden.
    expect(
      resolveAgentStartupPlanInputs({
        agent: 'claude',
        settings,
        platform: 'win32',
        isRemote: true,
        shell: undefined
      }).shell
    ).toBeUndefined()
    expect(
      resolveAgentStartupPlanInputs({
        agent: 'claude',
        settings,
        platform: 'darwin',
        isRemote: false,
        shell: undefined
      }).shell
    ).toBeUndefined()
  })

  it("lets the host's resolved shell override the configured one", () => {
    const inputs = resolveAgentStartupPlanInputs({
      agent: 'claude',
      settings: { terminalWindowsShell: 'git-bash' },
      platform: 'win32',
      isRemote: false,
      shell: 'cmd'
    })

    expect(inputs.shell).toBe('cmd')
  })

  it('ties sessionOptionsOverrideAgentArgs to whether options were actually picked', () => {
    const base = {
      agent: 'codex' as const,
      settings: EMPTY_SETTINGS,
      platform: 'darwin' as const,
      isRemote: false,
      shell: undefined
    }

    const without = resolveAgentStartupPlanInputs(base)
    expect(without.sessionOptionsOverrideAgentArgs).toBe(false)
    expect(without).not.toHaveProperty('sessionOptions')

    const withOptions = resolveAgentStartupPlanInputs({
      ...base,
      sessionOptions: { model: 'gpt-5' }
    })
    expect(withOptions.sessionOptionsOverrideAgentArgs).toBe(true)
    expect(withOptions.sessionOptions).toEqual({ model: 'gpt-5' })
  })
})

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
    // Without the override the configured flag trailed the picked one and won on argv order.
    expect(plan?.launchCommand).not.toContain('gpt-5-codex')
  })

  it('reports the picked option as launch-backed so the chat surface can render it', () => {
    expect(
      commandFor({ agentDefaultArgs: { codex: '--model gpt-5-codex' } })?.sessionOptions
    ).toEqual({ model: 'gpt-5' })
  })

  it('leaves non-conflicting configured arguments alone', () => {
    expect(commandFor({ agentDefaultArgs: { codex: '--search' } })?.launchCommand).toContain(
      "'--search'"
    )
  })
})

describe('an Orca-driven launch skips the startup update prompt (#15814, #18153)', () => {
  function planFor(
    agent: 'codex' | 'claude',
    suppressStartupUpdatePrompt: boolean,
    sessionOptions?: { model: string }
  ) {
    return buildAgentStartupPlan({
      ...resolveAgentStartupPlanInputs({
        agent,
        settings: { agentDefaultArgs: { codex: '--search' } },
        platform: 'darwin',
        isRemote: false,
        shell: undefined,
        suppressStartupUpdatePrompt,
        ...(sessionOptions ? { sessionOptions } : {})
      }),
      prompt: '',
      allowEmptyPromptLaunch: true
    })
  }

  it('adds Codex config only to the typed command, never to the resumable one', () => {
    for (const sessionOptions of [undefined, { model: 'gpt-5' }]) {
      const ordinary = planFor('codex', false, sessionOptions)
      const suppressed = planFor('codex', true, sessionOptions)
      expect(ordinary?.launchCommand).not.toContain('check_for_update_on_startup')
      expect(suppressed?.launchCommand).toBe(
        ordinary?.launchCommand.replace(/^codex/, "codex '-c' 'check_for_update_on_startup=false'")
      )
      expect(suppressed?.launchConfig).toEqual(ordinary?.launchConfig)
    }
  })

  it('leaves agents without a startup updater unchanged', () => {
    expect(planFor('claude', true)?.launchCommand).toBe(planFor('claude', false)?.launchCommand)
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

it.each([undefined, ''])(
  'keeps a terminal-only choice from args %s and projects its flag once for a legacy launch',
  (agentArgs) => {
    const inputs = resolveAgentStartupPlanInputs({
      agent: 'gemini',
      settings: {},
      agentArgs,
      platform: 'win32',
      isRemote: true,
      shell: 'powershell',
      sessionOptions: { permissionMode: 'full-access' }
    })
    const plan = buildAgentStartupPlan({ ...inputs, prompt: '', allowEmptyPromptLaunch: true })
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
  }
)
