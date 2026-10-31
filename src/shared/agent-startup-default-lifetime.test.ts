import * as optionCatalog from './agent-session-option-catalog'
import { describe, expect, it, vi } from 'vitest'
import {
  resolveAgentStartupPlanInputs,
  type AgentStartupSettings
} from './agent-startup-plan-inputs'
import { buildAgentStartupPlan, buildAgentResumeStartupPlan } from './tui-agent-startup'
import { resolveAgentLaunchCommand } from './tui-agent-launch-command'
import { resolveAgentChoiceLayers } from './agent-choice-layers'
import { getAgentSessionOptionLaunchCatalog } from './agent-session-option-catalog'
import { tokenizeStartupCommand, type AgentStartupShell } from './tui-agent-startup-shell'

function words(command: string, shell: AgentStartupShell = 'posix') {
  const parsed = tokenizeStartupCommand(command, shell)
  if (!parsed.ok) {
    throw new Error(parsed.error)
  }
  return parsed.tokens
}
const settings: AgentStartupSettings = {
  agentPermissionDefault: 'own',
  agentDefaultArgs: { claude: '--verbose', codex: '--search' },
  agentLaunchChoices: {
    claude: { model: 'opus', options: { effort: 'high' } },
    codex: { model: 'opaque-model', options: { effort: 'high' } }
  }
}
function fresh(
  agent: 'claude' | 'codex',
  overrides: Partial<Parameters<typeof resolveAgentStartupPlanInputs>[0]> = {}
) {
  const plan = buildAgentStartupPlan({
    ...resolveAgentStartupPlanInputs({
      agent,
      settings,
      platform: 'linux',
      isRemote: false,
      shell: 'posix',
      ...overrides
    }),
    prompt: '',
    allowEmptyPromptLaunch: true
  })
  if (!plan) {
    throw new Error('Missing startup')
  }
  return plan
}

describe('typed creation through the startup and recorded resume owners', () => {
  it.each(['claude', 'codex'] as const)(
    'seeds %s once and retains literal pins and real explicit picks',
    (agent) => {
      const plan = fresh(agent)
      expect(words(plan.launchCommand)).toContain(settings.agentLaunchChoices?.[agent]?.model)
      expect(plan.sessionOptions).toMatchObject({ effort: 'high' })
      expect(plan.launchConfig.agentArgs).toBe(settings.agentDefaultArgs?.[agent])
      const resume = buildAgentResumeStartupPlan({
        agent,
        providerSession: { key: 'session_id', id: 'continuing' },
        cmdOverrides: {},
        platform: 'linux',
        shell: 'posix',
        ...plan.launchConfig
      })
      expect(resume).not.toBeNull()
      expect(resume?.launchCommand).not.toContain(settings.agentLaunchChoices?.[agent]?.model)
      expect(resume?.launchCommand).not.toContain('high')
      const literal = fresh(agent, { agentArgs: '--model literal' })
      expect(words(literal.launchCommand)).toContain('literal')
      expect(literal.launchCommand).not.toContain('high')
      expect(literal.launchConfig.agentArgs).toBe('--model literal')
      const resumedPin = buildAgentResumeStartupPlan({
        agent,
        providerSession: { key: 'session_id', id: 'continuing' },
        cmdOverrides: {},
        platform: 'linux',
        shell: 'posix',
        ...literal.launchConfig
      })
      expect(words(resumedPin?.launchCommand ?? '')).toContain('literal')
      expect(fresh(agent, { agentArgs: null }).launchConfig.agentArgs).toBe('')
      expect(words(fresh(agent, { agentArgs: null }).launchCommand)).toContain(
        settings.agentLaunchChoices?.[agent]?.model
      )
      const explicit = fresh(agent, {
        agentArgs: '--model literal',
        sessionOptions: { model: 'picked', effort: 'low' }
      })
      expect(words(explicit.launchCommand)).toContain('picked')
      expect(explicit.launchCommand).not.toContain('literal')
      expect(explicit.launchConfig.agentCommand).not.toContain('picked')
    }
  )

  it('lets literal Command ownership defeat defaults while genuine picked conflicts still refuse', () => {
    const commandSettings = { ...settings, agentCmdOverrides: { claude: 'claude --model sonnet' } }
    const plan = fresh('claude', { settings: commandSettings })
    expect(plan.launchCommand).toBe("claude --model sonnet '--verbose'")
    expect(plan.launchConfig.agentCommand).toBe("claude --model sonnet '--verbose'")
    expect(plan.launchConfig.agentArgs).toBe('--verbose')
    expect(plan.sessionOptions).toBeUndefined()
    const explicit = resolveAgentLaunchCommand({
      ...resolveAgentStartupPlanInputs({
        agent: 'claude',
        settings: commandSettings,
        sessionOptions: { model: 'opus' },
        platform: 'linux',
        shell: 'posix',
        isRemote: false
      }),
      shell: 'posix'
    })
    expect(explicit).toMatchObject({ ok: false, error: expect.stringContaining('conflicts') })
    const alias = fresh('claude', {
      settings: { ...settings, agentCmdOverrides: { claude: 'cx' } }
    })
    expect(words(alias.launchCommand)).toEqual([
      'cx',
      '--verbose',
      '--model',
      'opus',
      '--effort',
      'high'
    ])
    expect(alias.launchConfig.agentCommand).toBe("cx '--verbose'")
  })

  it('uses accepted saved POSIX automation semantics on Windows without promoting configured raw', () => {
    const base = {
      platform: 'win32' as const,
      shell: 'powershell' as const,
      settings: { ...settings, agentDefaultArgs: { claude: '--model configured --verbose' } }
    }
    const model = fresh('claude', { ...base, extraAgentArgs: '--mo\\del automation-model' })
    expect(words(model.launchCommand, 'powershell')).toEqual([
      'claude',
      '--verbose',
      '--model',
      'automation-model'
    ])
    expect(words(model.launchConfig.agentCommand ?? '', 'powershell')).toContain('automation-model')
    expect(model.launchCommand).not.toContain('high')
    const repeatable = fresh('claude', { ...base, extraAgentArgs: '--add-dir docs' })
    expect(words(repeatable.launchCommand, 'powershell')).toEqual([
      'claude',
      '--verbose',
      '--add-dir',
      'docs',
      '--model',
      'opus',
      '--effort',
      'high'
    ])
    const effort = fresh('claude', { ...base, extraAgentArgs: '--effort low' })
    expect(words(effort.launchCommand, 'powershell')).toEqual([
      'claude',
      '--verbose',
      '--effort',
      'low',
      '--model',
      'opus'
    ])
    const explicit = fresh('claude', {
      ...base,
      extraAgentArgs: '--model automation-model',
      sessionOptions: { model: 'picked' }
    })
    expect(words(explicit.launchCommand, 'powershell')).toContain('picked')
    expect(explicit.launchCommand).not.toContain('automation-model')
    expect(() => fresh('claude', { extraAgentArgs: '--dangerously-skip-permissions' })).toThrow(
      /isn't allowed/
    )
  })
})

it('does zero model work on the real permission-only Command trigger at N/10N, and retains genuine work', () => {
  const catalog = getAgentSessionOptionLaunchCatalog('claude')
  if (!catalog?.modelApply.removeAgentArgs || !catalog.modelApply.launchArgs) {
    throw new Error('Missing model compiler')
  }
  const lookup = vi.spyOn(optionCatalog, 'getAgentSessionOptionLaunchCatalog')
  const remove = vi.spyOn(catalog.modelApply, 'removeAgentArgs')
  const compile = vi.spyOn(catalog.modelApply, 'launchArgs')
  try {
    const rows: { n: number; modelRemovals: number; modelCompiles: number }[] = []
    for (const n of [128, 1280]) {
      remove.mockClear()
      compile.mockClear()
      lookup.mockClear()
      const command = `claude ${'--verbose '.repeat(n)}`
      const result = resolveAgentLaunchCommand({
        agent: 'claude',
        platform: 'linux',
        shell: 'posix',
        cmdOverrides: { claude: command },
        agentArgs: '',
        sessionOptions: { permissionMode: 'own' },
        sessionOptionsOverrideAgentArgs: true
      })
      expect(result.ok).toBe(true)
      expect(lookup).not.toHaveBeenCalled()
      expect(remove).not.toHaveBeenCalled()
      expect(compile).not.toHaveBeenCalled()
      rows.push({
        n,
        modelRemovals: remove.mock.calls.length,
        modelCompiles: compile.mock.calls.length
      })
    }
    const conflict = resolveAgentLaunchCommand({
      agent: 'claude',
      platform: 'linux',
      shell: 'posix',
      cmdOverrides: { claude: 'claude --model sonnet' },
      sessionOptions: { model: 'opus' },
      sessionOptionsOverrideAgentArgs: true
    })
    expect(conflict).toMatchObject({ ok: false })
    expect(remove).toHaveBeenCalled()
    expect(compile).toHaveBeenCalled()
    remove.mockClear()
    expect(
      resolveAgentChoiceLayers({
        agent: 'claude',
        argumentOwner: 'launch',
        defaults: { options: { effort: 'high' } },
        userArgs: '--model literal'
      })
    ).toEqual({})
    expect(remove).toHaveBeenCalled()
    remove.mockClear()
    expect(
      resolveAgentChoiceLayers({
        agent: 'claude',
        argumentOwner: 'launch',
        remembered: { model: 'opus', options: { effort: 'high' } },
        defaults: { permissionMode: 'own' },
        userArgs: '--model literal'
      })
    ).toEqual({ permissionMode: 'own' })
    expect(remove).toHaveBeenCalled()
    process.stdout.write(`${JSON.stringify({ metric: 'empty-command-model-work', rows })}\n`)
  } finally {
    lookup.mockRestore()
    remove.mockRestore()
    compile.mockRestore()
  }
})
