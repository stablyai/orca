import { describe, expect, it } from 'vitest'
import {
  buildAgentDraftLaunchPlan,
  buildAgentResumeStartupPlan,
  buildAgentStartupPlan,
  buildShellCommandFromArgv,
  planAgentCliArgsSuffix
} from './tui-agent-startup'
import { TUI_AGENT_CONFIG } from './tui-agent-config'
import { normalizeTuiAgentArgsRecord, resolveTuiAgentLaunchArgs } from './tui-agent-launch-defaults'
import { tokenizeStartupCommand } from './tui-agent-startup-shell'
import {
  unwrapPosixShellScript,
  unwrapPowerShellScript
} from './tui-agent-startup-script.test-fixture'

describe('draft prefill teardown ordering (#14975)', () => {
  // Prefill cleanup expands fish_pid and can abort under set -u. Run after the agent so cleanup failure cannot block launch (#14975, reverted #14863).
  it('runs the clear after the agent command, never before it', () => {
    const plan = buildAgentDraftLaunchPlan({
      agent: 'pi',
      draft: 'hello',
      cmdOverrides: {},
      platform: 'darwin'
    })

    const command = plan?.launchCommand ?? ''
    expect(command.indexOf('pi')).toBeLessThan(command.indexOf('fish_pid'))
    expect(command).toMatch(/^pi;/)
  })
})

describe('tui agent startup plans', () => {
  it.each(['powershell', 'cmd'] as const)(
    'keeps the established invalid-quote error on %s',
    (shell) => {
      expect(planAgentCliArgsSuffix('--model "unterminated', shell)).toEqual({
        ok: false,
        error: 'CLI arguments are invalid: Unclosed quote in command template.'
      })
    }
  )

  it('passes the whole configured argument string to a terminal launch', () => {
    const plan = buildAgentStartupPlan({
      agent: 'claude',
      prompt: '',
      agentArgs: resolveTuiAgentLaunchArgs('claude', {
        agentDefaultArgs: { claude: '--dangerously-skip-permissions --model Opus' }
      }),
      cmdOverrides: {},
      platform: 'linux',
      allowEmptyPromptLaunch: true
    })

    expect(plan?.launchCommand).toBe("claude '--dangerously-skip-permissions' '--model' 'Opus'")
  })

  it('uses POSIX quoting when the target shell is Linux', () => {
    const plan = buildAgentStartupPlan({
      agent: 'claude',
      prompt: "fix Bob's branch",
      cmdOverrides: {},
      platform: 'linux'
    })

    expect(plan?.launchCommand).toBe("claude 'fix Bob'\"'\"'s branch'")
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

  // Why: a typed line break submits early, and PowerShell 5.1 without PSReadLine then hangs at `>>`.
  it('keeps a multi-line PowerShell launch on one physical line', () => {
    const plan = buildAgentStartupPlan({
      agent: 'claude',
      prompt: 'first line\nsecond $line',
      cmdOverrides: {},
      platform: 'win32'
    })

    expect(plan?.launchCommand).not.toMatch(/[\r\n]/)
    expect(plan?.launchCommand).toBe('claude "first line`nsecond `$line"')
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

  it('terminates Grok options before a flag-shaped POSIX prompt', () => {
    const plan = buildAgentStartupPlan({
      agent: 'grok',
      prompt: '--version',
      cmdOverrides: {},
      platform: 'linux'
    })

    expect(plan?.launchCommand).toBe("grok -- '--version'")
  })

  it('terminates Grok options before a flag-shaped PowerShell prompt', () => {
    const plan = buildAgentStartupPlan({
      agent: 'grok',
      prompt: '-h',
      cmdOverrides: {},
      platform: 'win32'
    })

    expect(plan?.launchCommand).toBe("grok -- '-h'")
  })

  it('terminates Grok options before a subcommand-shaped cmd prompt', () => {
    const plan = buildAgentStartupPlan({
      agent: 'grok',
      prompt: 'help',
      cmdOverrides: {},
      platform: 'win32',
      shell: 'cmd'
    })

    expect(plan?.launchCommand).toBe('grok -- "help"')
  })

  it('places the Grok prompt separator after configured agent arguments', () => {
    const plan = buildAgentStartupPlan({
      agent: 'grok',
      prompt: '--version',
      cmdOverrides: {},
      agentArgs: '--always-approve',
      platform: 'win32'
    })

    expect(plan?.launchCommand).toBe("grok '--always-approve' -- '--version'")
  })

  it('does not add the Grok prompt separator to other argv agents', () => {
    const plan = buildAgentStartupPlan({
      agent: 'codex',
      prompt: '--version',
      cmdOverrides: {},
      platform: 'linux'
    })

    expect(plan?.launchCommand).toBe("codex '-c' 'disable_paste_burst=true' '--version'")
  })

  it.each([
    { platform: 'linux' as const, shell: 'posix' as const },
    { platform: 'win32' as const, shell: 'powershell' as const },
    { platform: 'win32' as const, shell: 'cmd' as const }
  ])('delivers multiline Hermes queries through a child-only expansion on $shell', (testCase) => {
    const prompt = 'first line\nsecond "quoted" line with %PATH%'
    const plan = buildAgentStartupPlan({
      agent: 'hermes',
      prompt,
      cmdOverrides: {},
      agentArgs: '--yolo',
      platform: testCase.platform,
      shell: testCase.shell
    })

    expect(plan?.launchCommand).not.toContain(prompt)
    expect(plan?.followupPrompt).toBeNull()
    expect(plan?.launchConfig.agentCommand).toBe(
      buildAgentStartupPlan({
        agent: 'hermes',
        prompt: '',
        allowEmptyPromptLaunch: true,
        cmdOverrides: {},
        agentArgs: '--yolo',
        platform: testCase.platform,
        shell: testCase.shell
      })?.launchConfig.agentCommand
    )
    expect(plan?.env?.ORCA_HERMES_STARTUP_QUERY).toBe(prompt)
    const script =
      testCase.shell === 'posix'
        ? unwrapPosixShellScript(plan?.launchCommand)
        : unwrapPowerShellScript(plan?.launchCommand)
    expect(script).toContain("'hermes' 'chat'")
    expect(script).toContain('--query=')
    expect(testCase.shell === 'posix' ? plan?.launchCommand : script).toContain(
      'ORCA_HERMES_STARTUP_QUERY'
    )
    expect(script).toContain("'--yolo' '--tui'")
    expect(script).toContain(
      testCase.shell === 'posix'
        ? '--query=${__orca_hermes_startup_query}'
        : 'Remove-Item Env:ORCA_HERMES_STARTUP_QUERY'
    )
    if (testCase.shell === 'posix') {
      expect(plan?.launchCommand).toContain('unset ORCA_HERMES_STARTUP_QUERY')
    }
  })

  it('uses a sh invocation that POSIX-host PowerShell can parse', () => {
    const plan = buildAgentStartupPlan({
      agent: 'hermes',
      prompt: 'run it',
      cmdOverrides: {},
      platform: 'linux'
    })

    expect(plan?.launchCommand).toMatch(/^sh -c /)
    expect(plan?.launchCommand).not.toContain("'sh' '-c'")
    // Parse the outer portable quoting to prove octal escapes reach inner sh unchanged.
    const tokens = tokenizeStartupCommand(plan?.launchCommand ?? '', 'posix')
    expect(tokens.ok && tokens.tokens.at(-1)).toMatch(/\\0[0-7]{3}/)
  })

  it('does not launch Codex with the Orca profile when agent status hooks are enabled', () => {
    const plan = buildAgentStartupPlan({
      agent: 'codex',
      prompt: 'fix it',
      cmdOverrides: {},
      platform: 'linux'
    })

    expect(plan?.launchCommand).toBe("codex '-c' 'disable_paste_burst=true' 'fix it'")
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
      launchCommand: "codex '-c' 'disable_paste_burst=true'",
      expectedProcess: 'codex',
      followupPrompt: null,
      launchConfig: { agentCommand: 'codex', agentArgs: '', agentEnv: {} }
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

  it('uses the plain orca shim for Claude Agent Teams on Linux SSH remotes', () => {
    // Remote Linux deploys orca, never local-only orca-ide; using the renamed desktop wrapper breaks relay launches (#6500).
    const plan = buildAgentStartupPlan({
      agent: 'claude-agent-teams',
      prompt: '',
      cmdOverrides: {},
      platform: 'linux',
      isRemote: true,
      allowEmptyPromptLaunch: true
    })

    expect(plan?.launchCommand).toBe('orca claude-teams')
  })

  it('keeps the Windows orca.cmd shim for Claude Agent Teams on SSH remotes', () => {
    // Windows remote and local shims are both orca.cmd; remoteness must preserve that override.
    const plan = buildAgentStartupPlan({
      agent: 'claude-agent-teams',
      prompt: '',
      cmdOverrides: {},
      platform: 'win32',
      isRemote: true,
      allowEmptyPromptLaunch: true
    })

    expect(plan?.launchCommand).toBe('orca.cmd claude-teams')
  })

  it('keeps the Linux orca-ide wrapper for local (non-remote) Claude Agent Teams', () => {
    // Local Linux keeps orca-ide to avoid the GNOME screen-reader command clash.
    const plan = buildAgentStartupPlan({
      agent: 'claude-agent-teams',
      prompt: '',
      cmdOverrides: {},
      platform: 'linux',
      isRemote: false,
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
      followupPrompt: null,
      launchConfig: { agentCommand: 'openclaude', agentArgs: '', agentEnv: {} }
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
      followupPrompt: 'fix it',
      launchConfig: { agentCommand: 'vibe', agentArgs: '', agentEnv: {} }
    })
  })

  it('launches Qwen Code through the installed qwen executable', () => {
    const plan = buildAgentStartupPlan({
      agent: 'qwen-code',
      prompt: 'fix it',
      cmdOverrides: {},
      platform: 'linux'
    })

    expect(plan).toEqual({
      agent: 'qwen-code',
      launchCommand: 'qwen',
      expectedProcess: 'qwen',
      followupPrompt: 'fix it',
      launchConfig: { agentCommand: 'qwen', agentArgs: '', agentEnv: {} }
    })
  })

  it.each([
    ['yolo', 'linux', 'posix', undefined, "muse --trust-workspace '--yolo'"],
    ['manual', 'linux', 'posix', { muse: '' }, 'muse --trust-workspace'],
    ['yolo', 'darwin', 'posix', undefined, "muse --trust-workspace '--yolo'"],
    ['manual', 'darwin', 'posix', { muse: '' }, 'muse --trust-workspace'],
    ['yolo', 'win32', 'powershell', undefined, "muse --trust-workspace '--yolo'"],
    ['manual', 'win32', 'powershell', { muse: '' }, 'muse --trust-workspace'],
    ['yolo', 'win32', 'cmd', undefined, 'muse --trust-workspace "--yolo"'],
    ['manual', 'win32', 'cmd', { muse: '' }, 'muse --trust-workspace']
  ] as const)(
    'launches Muse in %s mode on %s/%s before delivering its prompt',
    (_, platform, shell, defaults, command) => {
      const plan = buildAgentStartupPlan({
        agent: 'muse',
        prompt: 'fix it',
        cmdOverrides: {},
        platform,
        shell,
        agentArgs: resolveTuiAgentLaunchArgs('muse', { agentDefaultArgs: defaults })
      })

      expect(plan).toMatchObject({
        agent: 'muse',
        launchCommand: command,
        expectedProcess: 'muse',
        followupPrompt: 'fix it'
      })
    }
  )

  it.each(['exec', 'resume', '--help'])(
    'delivers the reserved Muse prompt %s as text',
    (prompt) => {
      const plan = buildAgentStartupPlan({
        agent: 'muse',
        prompt,
        cmdOverrides: {},
        platform: 'linux'
      })
      expect(plan?.launchCommand).toBe('muse --trust-workspace')
      expect(plan?.followupPrompt).toBe(prompt)
    }
  )

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

    expect(plan?.launchCommand).toBe(
      "codex --profile work '-c' 'disable_paste_burst=true' 'fix it'"
    )
  })

  it('builds Windows resume plans that PowerShell can invoke', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'codex',
      providerSession: { key: 'session_id', id: 's1' },
      cmdOverrides: {},
      platform: 'win32'
    })

    expect(plan?.launchCommand).toBe("codex 'resume' 's1'")
    expect(plan?.startupCommandDelivery).toBe('shell-ready')
  })

  it('resumes an agent from the folder it ran in when the pane starts elsewhere (#16960)', () => {
    const resume = (cwd: string, launchCwd: string) =>
      buildAgentResumeStartupPlan({
        agent: 'claude',
        providerSession: { key: 'session_id', id: 's1', cwd },
        cmdOverrides: {},
        platform: 'darwin',
        launchCwd
      })?.launchCommand

    expect(resume('/repo/pkg', '/repo')).toBe("cd '/repo/pkg' && claude '--resume' 's1'")
    expect(resume('/repo/', '/repo')).toBe("claude '--resume' 's1'")
    expect(resume('/home/me/repo', '\\\\wsl.localhost\\Ubuntu\\home\\me\\repo')).toBe(
      "claude '--resume' 's1'"
    )
  })

  it('quotes Windows resume argv for cmd.exe when shell is cmd', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'grok',
      providerSession: { key: 'session_id', id: '019fc272-80fa-7a91-80a2-9c461ef1a9da' },
      cmdOverrides: {},
      agentArgs: '--permission-mode bypassPermissions',
      platform: 'win32',
      shell: 'cmd'
    })

    // cmd.exe needs double quotes or bare tokens; single quotes would become literal argv bytes.
    expect(plan?.launchCommand).toBe(
      'grok "--permission-mode" "bypassPermissions" "--resume" "019fc272-80fa-7a91-80a2-9c461ef1a9da"'
    )
  })

  it('keeps cmd-quoted agentCommand aligned with cmd resume suffix', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'grok',
      providerSession: { key: 'session_id', id: '019fc272-80fa-7a91-80a2-9c461ef1a9da' },
      cmdOverrides: {},
      agentCommand: 'grok "--permission-mode" "bypassPermissions"',
      platform: 'win32',
      shell: 'cmd'
    })

    // Regression: agentCommand from a prior cmd launch + PowerShell-default resume
    // suffix produced mixed quoting and broke reboot restore on cmd.exe tabs.
    expect(plan?.launchCommand).toBe(
      'grok "--permission-mode" "bypassPermissions" "--resume" "019fc272-80fa-7a91-80a2-9c461ef1a9da"'
    )
  })

  it('honors command overrides when building POSIX resume plans', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'codex',
      providerSession: { key: 'session_id', id: 's1' },
      cmdOverrides: { codex: 'codex --profile work' },
      platform: 'linux'
    })

    expect(plan?.launchCommand).toBe(
      "codex --profile work '-c' 'disable_paste_burst=true' 'resume' 's1'"
    )
  })

  it('uses a captured launch command when building resume plans after overrides change', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'codex',
      providerSession: { key: 'session_id', id: 's1' },
      cmdOverrides: { codex: 'codex --profile changed' },
      agentCommand: 'codex --profile captured',
      platform: 'linux'
    })

    expect(plan?.launchCommand).toBe(
      "codex --profile captured '-c' 'disable_paste_burst=true' 'resume' 's1'"
    )
    expect(plan?.launchConfig).toEqual({
      agentCommand: 'codex --profile captured',
      agentArgs: '',
      agentEnv: {}
    })
  })

  it('keeps an AI Vault OMP file locator separate from provider identity', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'omp',
      providerSession: { key: 'session_id', id: 'omp-session-1' },
      cmdOverrides: {},
      ompResumeFilePath: '/custom/root/project/session.jsonl',
      platform: 'linux'
    })

    expect(plan?.launchCommand).toBe("omp '--resume' '/custom/root/project/session.jsonl'")
    expect(plan?.launchConfig).toEqual({
      agentCommand: 'omp',
      agentArgs: '',
      agentEnv: {},
      ompResumeFilePath: '/custom/root/project/session.jsonl'
    })
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
    expect(plan?.launchConfig).toEqual({
      agentCommand: 'goose',
      agentArgs: '',
      agentEnv: { GOOSE_MODE: 'auto' }
    })
  })

  it('captures empty args and env as explicit launch config values', () => {
    const plan = buildAgentStartupPlan({
      agent: 'claude',
      prompt: '',
      cmdOverrides: {},
      agentArgs: '',
      agentEnv: {},
      platform: 'linux',
      allowEmptyPromptLaunch: true
    })

    expect(plan?.launchConfig).toEqual({ agentCommand: 'claude', agentArgs: '', agentEnv: {} })
  })

  it('does not append the unsupported OpenCode TUI skip-permissions arg', () => {
    const agentDefaultArgs = normalizeTuiAgentArgsRecord({
      opencode: '--dangerously-skip-permissions'
    })
    const plan = buildAgentStartupPlan({
      agent: 'opencode',
      prompt: 'fix it',
      cmdOverrides: {},
      agentArgs: resolveTuiAgentLaunchArgs('opencode', { agentDefaultArgs }),
      platform: 'linux'
    })

    expect(plan?.launchCommand).toBe("opencode --prompt 'fix it'")
  })

  it('keeps opencode and mimo-code on the cursor-gated paste draft route', () => {
    expect(TUI_AGENT_CONFIG.opencode.draftPasteReadySignal).toBe(
      'render-cursor-after-bracketed-paste'
    )
    expect(TUI_AGENT_CONFIG.opencode.draftPromptFlag).toBeUndefined()
    expect(TUI_AGENT_CONFIG.opencode.draftPromptEnvVar).toBeUndefined()
    expect(TUI_AGENT_CONFIG['mimo-code'].draftPasteReadySignal).toBe(
      'render-cursor-after-bracketed-paste'
    )
    expect(TUI_AGENT_CONFIG['mimo-code'].draftPromptFlag).toBeUndefined()
    expect(TUI_AGENT_CONFIG['mimo-code'].draftPromptEnvVar).toBeUndefined()
    // Without native draft plans, these agents must use cursor-gated paste readiness.
    expect(
      buildAgentDraftLaunchPlan({
        agent: 'opencode',
        draft: 'x',
        cmdOverrides: {},
        platform: 'darwin'
      })
    ).toBeNull()
    expect(
      buildAgentDraftLaunchPlan({
        agent: 'mimo-code',
        draft: 'x',
        cmdOverrides: {},
        platform: 'darwin'
      })
    ).toBeNull()
  })

  it('keeps grok on the composer-glyph paste draft route', () => {
    // Grok has no native prefill and its animated logo never settles; drafts must wait for its composer glyph.
    expect(TUI_AGENT_CONFIG.grok.draftPasteReadySignal).toBe('grok-composer-prompt')
    expect(TUI_AGENT_CONFIG.grok.draftPromptFlag).toBeUndefined()
    expect(TUI_AGENT_CONFIG.grok.draftPromptEnvVar).toBeUndefined()
    expect(
      buildAgentDraftLaunchPlan({
        agent: 'grok',
        draft: 'x',
        cmdOverrides: {},
        platform: 'darwin'
      })
    ).toBeNull()
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
    // OMP’s managed extension reads ORCA_OMP_PREFILL; sharing Pi’s var would lose drafts or replay stale Pi text.
    const plan = buildAgentDraftLaunchPlan({
      agent: 'omp',
      draft: 'fix the omp regression',
      cmdOverrides: {},
      platform: 'linux'
    })

    expect(plan).not.toBeNull()
    expect(plan?.env).toEqual({ ORCA_OMP_PREFILL: 'fix the omp regression' })
    expect(plan?.expectedProcess).toBe('omp')
    expect(plan?.launchConfig.agentCommand).toBe('omp')
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

  it('launches Rovo Dev as an acli subcommand and types the prompt after start', () => {
    // `acli rovodev run <instruction>` is one-shot, so the prompt must not ride argv.
    const plan = buildAgentStartupPlan({
      agent: 'rovo',
      prompt: 'fix it',
      cmdOverrides: {},
      agentArgs: resolveTuiAgentLaunchArgs('rovo', null),
      platform: 'linux'
    })
    expect(plan).toMatchObject({
      launchCommand: "acli rovodev run '--yolo'",
      expectedProcess: 'acli',
      followupPrompt: 'fix it'
    })
  })

  it('launches Devin with the prompt on argv behind a -- separator', () => {
    const plan = buildAgentStartupPlan({
      agent: 'devin',
      prompt: 'fix the tests',
      cmdOverrides: {},
      agentArgs: resolveTuiAgentLaunchArgs('devin', null),
      platform: 'linux'
    })
    expect(plan).toEqual({
      agent: 'devin',
      launchCommand:
        "devin '--permission-mode' 'bypass' '--respect-workspace-trust' 'false' -- 'fix the tests'",
      expectedProcess: 'devin',
      followupPrompt: null,
      launchConfig: {
        agentCommand: "devin '--permission-mode' 'bypass' '--respect-workspace-trust' 'false'",
        agentArgs: '--permission-mode bypass --respect-workspace-trust false',
        agentEnv: {}
      }
    })
  })

  it('excludes transient draft prompt env from launch config', () => {
    const plan = buildAgentDraftLaunchPlan({
      agent: 'pi',
      draft: 'prefill text',
      cmdOverrides: {},
      agentEnv: { ORCA_AGENT_MODE: 'managed' },
      platform: 'linux'
    })

    expect(plan?.env).toEqual({ ORCA_AGENT_MODE: 'managed', ORCA_PI_PREFILL: 'prefill text' })
    expect(plan?.launchConfig).toEqual({
      agentCommand: 'pi',
      agentArgs: '',
      agentEnv: { ORCA_AGENT_MODE: 'managed' }
    })
  })

  it('appends Devin default permission-mode bypass before stdin prompt delivery', () => {
    expect(resolveTuiAgentLaunchArgs('devin', null)).toBe(
      '--permission-mode bypass --respect-workspace-trust false'
    )
  })
})
