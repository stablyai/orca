import { describe, expect, it } from 'vitest'
import {
  buildAgentDraftLaunchPlan,
  buildAgentResumeStartupPlan,
  buildAgentStartupPlan,
  buildShellCommandFromArgv
} from './tui-agent-startup'
import { normalizeTuiAgentArgsRecord, resolveTuiAgentLaunchArgs } from './tui-agent-launch-defaults'

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

  it('invokes fully quoted argv commands in PowerShell', () => {
    expect(buildShellCommandFromArgv(['codex', 'resume', 's1'], 'powershell')).toBe(
      "& 'codex' 'resume' 's1'"
    )
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
    expect(plan?.startupCommandDelivery).toBe('shell-ready')
  })

  it('keeps plain empty Codex startup on the fast delivery path', () => {
    const plan = buildAgentStartupPlan({
      agent: 'codex',
      prompt: '',
      cmdOverrides: {},
      platform: 'linux',
      allowEmptyPromptLaunch: true
    })

    expect(plan).toEqual({
      agent: 'codex',
      launchCommand: 'codex',
      expectedProcess: 'codex',
      followupPrompt: null
    })
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

  it('uses the Linux Orca CLI command for Claude Agent Teams launches', () => {
    const plan = buildAgentStartupPlan({
      agent: 'claude-agent-teams',
      prompt: '',
      cmdOverrides: {},
      platform: 'linux',
      allowEmptyPromptLaunch: true
    })

    expect(plan?.launchCommand).toBe('orca-ide claude-teams')
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

  it('launches Mistral Vibe through the installed vibe executable', () => {
    const plan = buildAgentStartupPlan({
      agent: 'mistral-vibe',
      prompt: 'fix it',
      cmdOverrides: {},
      platform: 'linux'
    })

    expect(plan).toEqual({
      agent: 'mistral-vibe',
      launchCommand: 'vibe',
      expectedProcess: 'vibe',
      followupPrompt: 'fix it'
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

  it('builds Windows resume plans that PowerShell can invoke', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'codex',
      providerSession: { key: 'session_id', id: 's1' },
      cmdOverrides: {},
      platform: 'win32'
    })

    expect(plan?.launchCommand).toBe("codex 'resume' 's1'")
  })

  it('honors command overrides when building POSIX resume plans', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'codex',
      providerSession: { key: 'session_id', id: 's1' },
      cmdOverrides: { codex: 'codex --profile work' },
      platform: 'linux'
    })

    expect(plan?.launchCommand).toBe("codex --profile work 'resume' 's1'")
  })

  it('appends shell-quoted CLI arguments before prompt delivery flags', () => {
    const plan = buildAgentStartupPlan({
      agent: 'claude',
      prompt: 'fix it',
      cmdOverrides: {},
      agentArgs: '--model sonnet --add-dir "path with spaces"',
      platform: 'linux'
    })

    expect(plan?.launchCommand).toBe(
      "claude '--model' 'sonnet' '--add-dir' 'path with spaces' 'fix it'"
    )
  })

  it('uses PowerShell quoting for CLI arguments on Windows', () => {
    const plan = buildAgentStartupPlan({
      agent: 'claude',
      prompt: 'fix it',
      cmdOverrides: {},
      agentArgs: '--model sonnet --name "Bob\'s"',
      platform: 'win32'
    })

    expect(plan?.launchCommand).toBe("claude '--model' 'sonnet' '--name' 'Bob''s' 'fix it'")
  })

  it('carries agent launch environment defaults into startup plans', () => {
    const plan = buildAgentStartupPlan({
      agent: 'goose',
      prompt: '',
      cmdOverrides: {},
      agentEnv: { GOOSE_MODE: 'auto' },
      platform: 'linux',
      allowEmptyPromptLaunch: true
    })

    expect(plan?.launchCommand).toBe('goose')
    expect(plan?.env).toEqual({ GOOSE_MODE: 'auto' })
  })

  it('does not append the unsupported OpenCode TUI skip-permissions arg', () => {
    const agentDefaultArgs = normalizeTuiAgentArgsRecord({
      opencode: '--dangerously-skip-permissions'
    })
    const plan = buildAgentStartupPlan({
      agent: 'opencode',
      prompt: 'fix it',
      cmdOverrides: {},
      agentArgs: resolveTuiAgentLaunchArgs('opencode', agentDefaultArgs),
      platform: 'linux'
    })

    expect(plan?.launchCommand).toBe("opencode --prompt 'fix it'")
  })

  it('appends Kiro trust defaults to the chat subcommand that accepts them', () => {
    const plan = buildAgentStartupPlan({
      agent: 'kiro',
      prompt: 'fix it',
      cmdOverrides: {},
      agentArgs: '--trust-all-tools',
      platform: 'linux'
    })

    expect(plan?.launchCommand).toBe("kiro-cli chat --tui '--trust-all-tools'")
  })

  it('launches Continue through the documented cn binary', () => {
    const plan = buildAgentStartupPlan({
      agent: 'continue',
      prompt: 'fix it',
      cmdOverrides: {},
      agentArgs: '--allow "*"',
      platform: 'linux'
    })

    expect(plan?.launchCommand).toBe("cn '--allow' '*'")
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
    // Why: OMP owns its own managed prefill extension and env var.
    // orca-prefill.ts reads ORCA_OMP_PREFILL for OMP launches — see
    // src/main/pi/titlebar-extension-service.ts — so a draft plan for OMP
    // MUST emit that name. A regression here would either silently drop the
    // draft (Pi var ignored by OMP) or honor a stale Pi-PTY draft.
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

  it('returns null for oversized Windows flag drafts so callers paste after ready', () => {
    expect(
      buildAgentDraftLaunchPlan({
        agent: 'claude',
        draft: 'x'.repeat(25_000),
        cmdOverrides: {},
        platform: 'win32'
      })
    ).toBeNull()
  })

  it('returns null for oversized Windows env-var drafts so callers paste after ready', () => {
    expect(
      buildAgentDraftLaunchPlan({
        agent: 'pi',
        draft: 'x'.repeat(25_000),
        cmdOverrides: {},
        platform: 'win32'
      })
    ).toBeNull()
  })

  it('launches Devin with stdin-after-start prompt delivery', () => {
    const plan = buildAgentStartupPlan({
      agent: 'devin',
      prompt: 'fix the tests',
      cmdOverrides: {},
      agentArgs: resolveTuiAgentLaunchArgs('devin', null),
      platform: 'linux'
    })
    expect(plan).toEqual({
      agent: 'devin',
      launchCommand: "devin '--permission-mode' 'bypass'",
      expectedProcess: 'devin',
      followupPrompt: 'fix the tests'
    })
  })

  it('appends Devin default permission-mode bypass before stdin prompt delivery', () => {
    expect(resolveTuiAgentLaunchArgs('devin', null)).toBe('--permission-mode bypass')
  })
})
