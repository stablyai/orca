import { describe, expect, it } from 'vitest'
import { buildAgentDraftLaunchPlan, buildAgentStartupPlan } from './tui-agent-startup'

describe('tui agent startup plans', () => {
  it('uses POSIX quoting when the target shell is Linux', () => {
    const plan = buildAgentStartupPlan({
      agent: 'claude',
      prompt: "fix Bob's branch",
      cmdOverrides: {},
      platform: 'linux'
    })

    expect(plan?.launchCommand).toBe("claude 'fix Bob'\\''s branch'")
  })

  it('uses PowerShell quoting by default when the target shell is Windows', () => {
    const plan = buildAgentStartupPlan({
      agent: 'claude',
      prompt: 'fix Bob\'s "quoted" branch',
      cmdOverrides: {},
      platform: 'win32'
    })

    expect(plan?.launchCommand).toBe("claude 'fix Bob''s \"quoted\" branch'")
  })

  it('uses cmd escaping when requested explicitly', () => {
    const plan = buildAgentStartupPlan({
      agent: 'claude',
      prompt: 'fix "quoted" & %PATH%',
      cmdOverrides: {},
      platform: 'win32',
      shell: 'cmd'
    })

    expect(plan?.launchCommand).toBe('claude "fix ^"quoted^" ^& ^%PATH^%"')
  })

  it('does not launch Codex with the Orca profile when agent status hooks are enabled', () => {
    const plan = buildAgentStartupPlan({
      agent: 'codex',
      prompt: 'fix it',
      cmdOverrides: {},
      platform: 'linux'
    })

    expect(plan?.launchCommand).toBe("codex 'fix it'")
  })

  it('launches Claude without Orca settings injection', () => {
    const plan = buildAgentStartupPlan({
      agent: 'claude',
      prompt: 'fix it',
      cmdOverrides: {},
      platform: 'linux'
    })

    expect(plan?.launchCommand).toBe("claude 'fix it'")
    expect(plan?.launchCommand).not.toContain('--settings')
  })

  it('launches OpenClaude as a distinct argv agent', () => {
    const plan = buildAgentStartupPlan({
      agent: 'openclaude',
      prompt: 'fix it',
      cmdOverrides: {},
      platform: 'linux'
    })

    expect(plan).toEqual({
      agent: 'openclaude',
      launchCommand: "openclaude 'fix it'",
      expectedProcess: 'openclaude',
      followupPrompt: null
    })
  })

  it('leaves Claude command overrides untouched', () => {
    const plan = buildAgentStartupPlan({
      agent: 'claude',
      prompt: 'fix it',
      cmdOverrides: { claude: 'claude --dangerously-skip-permissions' },
      platform: 'linux'
    })

    expect(plan?.launchCommand).toBe("claude --dangerously-skip-permissions 'fix it'")
  })

  it('leaves Codex command overrides untouched', () => {
    const plan = buildAgentStartupPlan({
      agent: 'codex',
      prompt: 'fix it',
      cmdOverrides: { codex: 'codex --profile work' },
      platform: 'linux'
    })

    expect(plan?.launchCommand).toBe("codex --profile work 'fix it'")
  })

  it('clears draft environment variables with the target shell syntax', () => {
    expect(
      buildAgentDraftLaunchPlan({
        agent: 'pi',
        draft: 'https://github.com/acme/repo/issues/42',
        cmdOverrides: {},
        platform: 'win32'
      })?.launchCommand
    ).toBe('pi; Remove-Item Env:ORCA_PI_PREFILL -ErrorAction SilentlyContinue')

    expect(
      buildAgentDraftLaunchPlan({
        agent: 'pi',
        draft: 'https://github.com/acme/repo/issues/42',
        cmdOverrides: {},
        platform: 'win32',
        shell: 'cmd'
      })?.launchCommand
    ).toBe('pi & set "ORCA_PI_PREFILL="')
  })

  it('returns an OMP draft plan with ORCA_OMP_PREFILL (OMP-scoped, not Pi-shared)', () => {
    // Why: OMP owns its own overlay tree, bundled prefill extension, and
    // prefill env var. The OMP overlay's orca-prefill.ts reads
    // ORCA_OMP_PREFILL — see src/main/pi/titlebar-extension-service.ts —
    // so a draft plan for OMP MUST emit that name. A regression here would
    // either silently drop the draft (Pi var ignored by OMP overlay) or
    // honor a stale Pi-PTY draft from a previous launch.
    const plan = buildAgentDraftLaunchPlan({
      agent: 'omp',
      draft: 'fix the omp regression',
      cmdOverrides: {},
      platform: 'linux'
    })

    expect(plan).not.toBeNull()
    expect(plan?.env).toEqual({ ORCA_OMP_PREFILL: 'fix the omp regression' })
    expect(plan?.expectedProcess).toBe('omp')
    expect(plan?.launchCommand).toBe('omp; unset ORCA_OMP_PREFILL')
  })
})
