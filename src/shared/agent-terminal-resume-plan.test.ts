import { describe, expect, it } from 'vitest'
import { buildAgentTerminalResumePlan } from './agent-terminal-resume-plan'
import { agentResumeCurrentInputs, type AgentTerminalResume } from './agent-terminal-resume'
import { AgentTerminalResumeParam } from './rpc-contract/agent-terminal-resume-params'
import type { AgentStartupSettings } from './agent-startup-plan-inputs'

const runtime = {
  platform: 'linux',
  pty: { shellOverride: undefined, terminalWindowsWslDistro: null }
} as const
const providerSession = { key: 'session_id', id: 'session-1', cwd: '/original' } as const
const settings: AgentStartupSettings = {
  agentCmdOverrides: { claude: 'host-claude' },
  agentDefaultArgs: { claude: '--model host-model' },
  agentDefaultEnv: { claude: { SETTINGS: 'host' } },
  agentPermissionDefault: 'ask'
}
function plan(resume: AgentTerminalResume) {
  return buildAgentTerminalResumePlan({
    agent: 'claude',
    providerSession,
    resume,
    settings,
    runtime,
    isRemote: false,
    launchCwd: '/selected'
  })!
}

describe('execution-host resume recipes', () => {
  it('distinguishes omitted host defaults from absent saved inputs', () => {
    const defaults = plan({ recipe: { source: 'host-defaults' } })
    const saved = plan({ recipe: { source: 'saved' } })
    expect(defaults.launchCommand).toContain('host-model')
    expect(defaults.env).toEqual({ SETTINGS: 'host' })
    expect(saved.launchCommand).not.toContain('host-model')
    expect(saved.launchCommand).not.toContain('permission-mode')
    expect(saved.launchConfig.agentArgs).toBe('')
    expect(saved.env).toEqual({})
  })

  it('keeps literal saved arguments and env separate from current permissions', () => {
    const result = plan({
      recipe: {
        source: 'saved',
        launchConfig: {
          agentCommand: 'recorded-claude',
          agentArgs: '--model recorded',
          agentEnv: { SETTINGS: 'recorded' }
        }
      }
    })
    expect(result.launchCommand).toContain('recorded-claude')
    expect(result.launchCommand).not.toContain('host-claude')
    expect(result.launchCommand).not.toContain('host-model')
    expect(result.launchConfig.agentArgs).toBe('--model recorded')
    expect(result.env).toEqual({ SETTINGS: 'recorded' })
  })

  it('captures the selected profile before host settings or the caller change', () => {
    const selected: AgentStartupSettings = {
      agentCmdOverrides: { claude: 'selected-claude' },
      agentDefaultArgs: { claude: '--model selected' },
      agentDefaultEnv: { claude: { SETTINGS: 'selected' } },
      agentPermissionDefault: 'own'
    }
    const snapshot = agentResumeCurrentInputs('claude', selected)
    selected.agentDefaultEnv!.claude!.SETTINGS = 'later'
    const result = plan({ recipe: { source: 'current-inputs', settings: snapshot } })
    expect(result.launchCommand).toContain('selected-claude')
    expect(result.launchCommand).toContain('selected')
    expect(result.launchCommand).not.toContain('permission-mode')
    expect(result.env).toEqual({ SETTINGS: 'selected' })
  })

  it('preserves recorded cwd unless the caller chose the launch folder', () => {
    expect(plan({ recipe: { source: 'saved' } }).launchCommand).toContain('/original')
    expect(
      plan({ recipe: { source: 'saved' }, resumeInLaunchCwd: true }).launchCommand
    ).not.toContain('/original')
  })

  it('keeps Codex permission restoration in the existing resume builder', () => {
    const result = buildAgentTerminalResumePlan({
      agent: 'codex',
      providerSession,
      settings: {},
      runtime,
      isRemote: false,
      resume: {
        recipe: {
          source: 'saved',
          launchConfig: {
            agentCommand: "codex '--dangerously-bypass-approvals-and-sandbox'",
            agentArgs: '--dangerously-bypass-approvals-and-sandbox',
            agentEnv: {}
          }
        }
      }
    })
    expect(result?.launchCommand).toContain('resume')
    expect(result?.launchCommand).not.toContain('dangerously-bypass')
  })

  it('normalizes the OMP transcript on its execution runtime', () => {
    const result = buildAgentTerminalResumePlan({
      agent: 'omp',
      providerSession,
      settings: {},
      runtime,
      isRemote: false,
      resume: {
        recipe: { source: 'saved' },
        ompResumeFilePath: '\\\\wsl$\\Ubuntu\\home\\qa\\session.jsonl'
      }
    })
    expect(result?.launchCommand).toContain('/home/qa/session.jsonl')
    expect(result?.launchCommand).not.toContain('wsl$')
  })

  it('accepts selected permissions and refuses mixed recipe sources at the wire boundary', () => {
    expect(
      AgentTerminalResumeParam.safeParse({
        recipe: {
          source: 'current-inputs',
          settings: { agentPermissionDefault: 'accept-edits' }
        }
      }).success
    ).toBe(true)
    expect(
      AgentTerminalResumeParam.safeParse({
        recipe: {
          source: 'saved',
          settings: {},
          launchConfig: undefined
        }
      }).success
    ).toBe(false)
  })
})
