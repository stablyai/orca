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

function unwrapPosixShellScript(command: string | undefined): string {
  const tokenized = tokenizeStartupCommand(command ?? '', 'posix')
  expect(tokenized.ok).toBe(true)
  const wrapper = tokenized.ok ? (tokenized.tokens[2] ?? '') : ''
  const encoded = wrapper.match(/printf %b "([\\0-7]+)"/)?.[1]
  if (!encoded) {
    return wrapper
  }
  const bytes = [...encoded.matchAll(/\\0([0-7]{3})/g)].map((match) => Number.parseInt(match[1], 8))
  return new TextDecoder().decode(new Uint8Array(bytes))
}

function unwrapPowerShellScript(command: string | undefined): string {
  const encoded = command?.match(/-EncodedCommand\s+(\S+)/)?.[1]
  expect(encoded).toBeDefined()
  return Buffer.from(encoded!, 'base64').toString('utf16le')
}

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

    expect(plan?.launchCommand).toBe("codex '--version'")
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
    expect(plan?.launchConfig.agentCommand).toBe('hermes --tui')
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
    expect(plan?.launchCommand).toMatch(/\\0[0-7]{3}/)
    expect(plan?.launchCommand).not.toContain("'sh' '-c'")
    expect(plan?.launchCommand).not.toContain("'\\''")
  })

  it('moves Hermes command override flags after the chat subcommand', () => {
    const plan = buildAgentStartupPlan({
      agent: 'hermes',
      prompt: 'run privately',
      cmdOverrides: { hermes: 'hermes --tui --provider anthropic' },
      agentArgs: '--yolo',
      platform: 'linux'
    })

    const script = unwrapPosixShellScript(plan?.launchCommand)
    expect(script).toContain("'--provider' 'anthropic' '--yolo' '--tui'")
    expect(plan?.env?.ORCA_HERMES_STARTUP_QUERY).toBe('run privately')
  })

  it.each([
    {
      shell: 'powershell' as const,
      override: '"C:\\Program Files\\Hermes\\hermes.exe" --tui',
      expected: "& 'C:\\Program Files\\Hermes\\hermes.exe' 'chat'"
    },
    {
      shell: 'cmd' as const,
      override: 'C:\\Tools\\hermes.exe --tui',
      expected: "& 'C:\\Tools\\hermes.exe' 'chat'"
    }
  ])('preserves Windows paths in Hermes command overrides on $shell', (testCase) => {
    const plan = buildAgentStartupPlan({
      agent: 'hermes',
      prompt: 'run it',
      cmdOverrides: { hermes: testCase.override },
      platform: 'win32',
      shell: testCase.shell
    })

    expect(unwrapPowerShellScript(plan?.launchCommand)).toContain(testCase.expected)
  })

  it('removes a configured duplicate chat subcommand', () => {
    const plan = buildAgentStartupPlan({
      agent: 'hermes',
      prompt: 'run it',
      cmdOverrides: { hermes: 'hermes --provider copilot chat --tui' },
      agentArgs: '--provider copilot chat --yolo',
      platform: 'linux'
    })

    const script = unwrapPosixShellScript(plan?.launchCommand)
    expect(script.match(/'chat'/g)).toHaveLength(1)
    expect(script).toContain("'--provider' 'copilot' '--yolo'")
  })

  it('preserves an option value named chat', () => {
    const plan = buildAgentStartupPlan({
      agent: 'hermes',
      prompt: 'run it',
      cmdOverrides: { hermes: 'hermes --profile chat --tui' },
      platform: 'linux'
    })

    expect(unwrapPosixShellScript(plan?.launchCommand)).toContain("'--profile' 'chat'")
  })

  it('keeps Orca ownership of the Hermes startup query and TUI mode', () => {
    const plan = buildAgentStartupPlan({
      agent: 'hermes',
      prompt: 'automation prompt',
      cmdOverrides: { hermes: 'hermes --query override --cli' },
      agentArgs: '-q=second-override --query=third-override -qfourth-override --tui',
      platform: 'linux'
    })

    const script = unwrapPosixShellScript(plan?.launchCommand)
    expect(script.match(/--query=/g)).toHaveLength(1)
    expect(script).not.toContain('override')
    expect(script).not.toContain("'--cli'")
    expect(script.match(/'--tui'/g)).toHaveLength(1)
    expect(plan?.env?.ORCA_HERMES_STARTUP_QUERY).toBe('automation prompt')
  })

  it('preserves wrapper tokens before the Hermes executable', () => {
    const plan = buildAgentStartupPlan({
      agent: 'hermes',
      prompt: 'run it',
      cmdOverrides: { hermes: 'uv run hermes --tui' },
      platform: 'linux'
    })

    expect(unwrapPosixShellScript(plan?.launchCommand)).toContain("'uv' 'run' 'hermes' 'chat'")
  })

  it('selects the final Hermes executable token in a wrapper', () => {
    const plan = buildAgentStartupPlan({
      agent: 'hermes',
      prompt: 'run it',
      cmdOverrides: { hermes: 'sudo -u hermes hermes --tui' },
      platform: 'linux'
    })

    expect(unwrapPosixShellScript(plan?.launchCommand)).toContain(
      "'sudo' '-u' 'hermes' 'hermes' 'chat'"
    )
  })

  it('selects the wrapped executable when the wrapper and command both name Hermes', () => {
    const plan = buildAgentStartupPlan({
      agent: 'hermes',
      prompt: 'run it',
      cmdOverrides: { hermes: 'sudo -u hermes hermes chat --tui' },
      platform: 'linux'
    })

    const script = unwrapPosixShellScript(plan?.launchCommand)
    expect(script).toContain("'sudo' '-u' 'hermes' 'hermes' 'chat'")
    expect(script.match(/'chat'/g)).toHaveLength(1)
  })

  it('does not mistake a Hermes option value for a wrapped executable', () => {
    const plan = buildAgentStartupPlan({
      agent: 'hermes',
      prompt: 'run it',
      cmdOverrides: { hermes: 'hermes chat --resume hermes --tui' },
      platform: 'linux'
    })

    const script = unwrapPosixShellScript(plan?.launchCommand)
    expect(script.match(/'chat'/g)).toHaveLength(1)
    expect(script).toContain("'--resume' 'hermes'")
  })

  it('preserves POSIX environment-assignment command prefixes', () => {
    const plan = buildAgentStartupPlan({
      agent: 'hermes',
      prompt: 'run it',
      cmdOverrides: { hermes: 'HERMES_HOME=/tmp/test uv run hermes --tui' },
      platform: 'linux'
    })

    expect(unwrapPosixShellScript(plan?.launchCommand)).toContain(
      "'env' 'HERMES_HOME=/tmp/test' 'uv' 'run' 'hermes' 'chat'"
    )
  })

  it('rejects a Hermes command override with no identifiable executable', () => {
    expect(
      buildAgentStartupPlan({
        agent: 'hermes',
        prompt: 'run it',
        cmdOverrides: { hermes: 'custom-agent --tui' },
        platform: 'linux'
      })
    ).toBeNull()
  })

  it('rejects Hermes queries that exceed the safe Windows environment limit', () => {
    const plan = buildAgentStartupPlan({
      agent: 'hermes',
      prompt: 'x'.repeat(24_000),
      cmdOverrides: {},
      platform: 'win32'
    })

    expect(plan).toBeNull()
  })

  it.each(['quote "this"', 'print %PATH%', 'toggle !feature!', 'inspect C:\\repo\\'])(
    'keeps a complex cmd Hermes query out of command text: %s',
    (prompt) => {
      const plan = buildAgentStartupPlan({
        agent: 'hermes',
        prompt,
        cmdOverrides: {},
        platform: 'win32',
        shell: 'cmd'
      })

      expect(plan?.launchCommand).not.toContain(prompt)
      expect(plan?.env?.ORCA_HERMES_STARTUP_QUERY).toBe(prompt)
    }
  )

  it('uses the Windows remote default shell for SSH Hermes queries', () => {
    const plan = buildAgentStartupPlan({
      agent: 'hermes',
      prompt: 'run remotely',
      cmdOverrides: {},
      platform: 'win32',
      isRemote: true
    })

    expect(unwrapPowerShellScript(plan?.launchCommand)).toContain(
      "& 'hermes' 'chat' \"--query=$orcaHermesNativeQuery\" '--tui'"
    )
  })

  it('measures POSIX Hermes query limits in UTF-8 bytes', () => {
    const plan = buildAgentStartupPlan({
      agent: 'hermes',
      prompt: '界'.repeat(50_000),
      cmdOverrides: {},
      platform: 'linux'
    })

    expect(plan).toBeNull()
  })

  it('keeps empty Hermes launches on the interactive TUI command', () => {
    const plan = buildAgentStartupPlan({
      agent: 'hermes',
      prompt: '',
      cmdOverrides: {},
      platform: 'linux',
      allowEmptyPromptLaunch: true
    })

    expect(plan?.launchCommand).toBe('hermes --tui')
    expect(plan?.followupPrompt).toBeNull()
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
    // Why: the SSH relay deploys the CLI shim as `orca` (not the local-only
    // `orca-ide` GNOME-screen-reader workaround), so a remote launch must not
    // emit `orca-ide claude-teams` — that name is not on the remote PATH and
    // `claude-teams` is rejected by the relay's CLI switch (issue #6500).
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
    // Why: the Windows remote shim is also `orca.cmd`, matching the local
    // win32 override, so remoteness must not alter the Windows command.
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
    // Why: the `orca-ide` rename is still required for a local Linux desktop
    // install (avoids shadowing the GNOME Orca screen reader), so an explicit
    // isRemote:false must preserve it.
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

  it('uses a captured launch command when building resume plans after overrides change', () => {
    const plan = buildAgentResumeStartupPlan({
      agent: 'codex',
      providerSession: { key: 'session_id', id: 's1' },
      cmdOverrides: { codex: 'codex --profile changed' },
      agentCommand: 'codex --profile captured',
      platform: 'linux'
    })

    expect(plan?.launchCommand).toBe("codex --profile captured 'resume' 's1'")
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
      agentArgs: resolveTuiAgentLaunchArgs('opencode', agentDefaultArgs),
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
    // Why: no native draft launch plan means both agents fall through to the
    // cursor-gated paste-after-ready route, where the new signal applies.
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
      followupPrompt: 'fix the tests',
      launchConfig: {
        agentCommand: "devin '--permission-mode' 'bypass'",
        agentArgs: '--permission-mode bypass',
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
    expect(resolveTuiAgentLaunchArgs('devin', null)).toBe('--permission-mode bypass')
  })
})
