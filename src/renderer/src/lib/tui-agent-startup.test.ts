import { describe, expect, it } from 'vitest'
import {
  buildAgentDraftLaunchPlan,
  buildAgentStartupPlan,
  isShellProcess
} from './tui-agent-startup'

describe('buildAgentStartupPlan', () => {
  it('passes Claude prompts as a positional interactive argument', () => {
    expect(
      buildAgentStartupPlan({
        agent: 'claude',
        prompt: 'Fix the bug',
        cmdOverrides: {},
        platform: 'darwin'
      })
    ).toEqual({
      agent: 'claude',
      launchCommand: "claude 'Fix the bug'",
      expectedProcess: 'claude',
      followupPrompt: null
    })
  })

  it('uses Gemini interactive prompt mode instead of dropping the prompt', () => {
    expect(
      buildAgentStartupPlan({
        agent: 'gemini',
        prompt: 'Investigate this regression',
        cmdOverrides: {},
        platform: 'linux'
      })
    ).toEqual({
      agent: 'gemini',
      launchCommand: "gemini --prompt-interactive 'Investigate this regression'",
      expectedProcess: 'gemini',
      followupPrompt: null
    })
  })

  it('launches aider first and injects the draft prompt after startup', () => {
    expect(
      buildAgentStartupPlan({
        agent: 'aider',
        prompt: 'Refactor the parser',
        cmdOverrides: {},
        platform: 'linux'
      })
    ).toEqual({
      agent: 'aider',
      launchCommand: 'aider',
      expectedProcess: 'aider',
      followupPrompt: 'Refactor the parser'
    })
  })

  it('launches Autohand Code first and injects the draft prompt after startup', () => {
    expect(
      buildAgentStartupPlan({
        agent: 'autohand',
        prompt: 'Add tests for the parser',
        cmdOverrides: {},
        platform: 'linux'
      })
    ).toEqual({
      agent: 'autohand',
      launchCommand: 'autohand',
      expectedProcess: 'autohand',
      followupPrompt: 'Add tests for the parser'
    })
  })

  it('uses cursor-agent as the actual launch binary', () => {
    expect(
      buildAgentStartupPlan({
        agent: 'cursor',
        prompt: 'Review this file',
        cmdOverrides: {},
        platform: 'darwin'
      })
    ).toEqual({
      agent: 'cursor',
      launchCommand: "cursor-agent 'Review this file'",
      expectedProcess: 'cursor-agent',
      followupPrompt: null
    })
  })

  it('applies command overrides without changing the prompt syntax contract', () => {
    expect(
      buildAgentStartupPlan({
        agent: 'droid',
        prompt: 'Ship the fix',
        cmdOverrides: { droid: '/opt/factory/bin/droid' },
        platform: 'linux'
      })
    ).toEqual({
      agent: 'droid',
      launchCommand: "/opt/factory/bin/droid 'Ship the fix'",
      expectedProcess: 'droid',
      followupPrompt: null
    })
  })

  it('passes Copilot prompts with the -i flag for an interactive session', () => {
    expect(
      buildAgentStartupPlan({
        agent: 'copilot',
        prompt: 'Fix the bug',
        cmdOverrides: {},
        platform: 'darwin'
      })
    ).toEqual({
      agent: 'copilot',
      launchCommand: "copilot -i 'Fix the bug'",
      expectedProcess: 'copilot',
      followupPrompt: null
    })
  })

  it('returns null when there is no prompt to inject', () => {
    expect(
      buildAgentStartupPlan({
        agent: 'codex',
        prompt: '   ',
        cmdOverrides: {},
        platform: 'darwin'
      })
    ).toBeNull()
  })

  it('uses -i flag for copilot to start an interactive session with initial prompt', () => {
    expect(
      buildAgentStartupPlan({
        agent: 'copilot',
        prompt: 'Fix the bug',
        cmdOverrides: {},
        platform: 'darwin'
      })
    ).toEqual({
      agent: 'copilot',
      launchCommand: "copilot -i 'Fix the bug'",
      expectedProcess: 'copilot',
      followupPrompt: null
    })
  })
})

describe('buildAgentDraftLaunchPlan', () => {
  it('uses Claude --prefill to seed the input box without submitting', () => {
    expect(
      buildAgentDraftLaunchPlan({
        agent: 'claude',
        draft: 'https://github.com/acme/repo/issues/42',
        cmdOverrides: {},
        platform: 'darwin'
      })
    ).toEqual({
      agent: 'claude',
      launchCommand: "claude --prefill 'https://github.com/acme/repo/issues/42'",
      expectedProcess: 'claude'
    })
  })

  it('returns null for agents without a documented prefill flag', () => {
    expect(
      buildAgentDraftLaunchPlan({
        agent: 'codex',
        draft: 'https://github.com/acme/repo/issues/42',
        cmdOverrides: {},
        platform: 'darwin'
      })
    ).toBeNull()
  })

  it('uses ORCA_PI_PREFILL env var for pi (no CLI flag exists)', () => {
    // Why: pi has no `--prefill` flag, and bracketed-paste-after-ready races
    // against pi's lengthy startup output. The Orca overlay installs an
    // `orca-prefill` extension that reads ORCA_PI_PREFILL on session_start
    // and seeds the editor. Plan plumbs the env var without polluting the
    // shell command (no `FOO='...' pi` prefix typed into the terminal).
    expect(
      buildAgentDraftLaunchPlan({
        agent: 'pi',
        draft: 'https://github.com/acme/repo/issues/42',
        cmdOverrides: {},
        platform: 'darwin'
      })
    ).toEqual({
      agent: 'pi',
      launchCommand: 'pi; unset ORCA_PI_PREFILL',
      expectedProcess: 'pi',
      env: { ORCA_PI_PREFILL: 'https://github.com/acme/repo/issues/42' }
    })
  })

  it('uses cmd.exe syntax to clear the pi prefill var when Windows shell is cmd', () => {
    expect(
      buildAgentDraftLaunchPlan({
        agent: 'pi',
        draft: 'https://github.com/acme/repo/issues/42',
        cmdOverrides: {},
        platform: 'win32',
        windowsShell: 'cmd.exe'
      })
    ).toEqual({
      agent: 'pi',
      launchCommand: 'pi; set "ORCA_PI_PREFILL="',
      expectedProcess: 'pi',
      env: { ORCA_PI_PREFILL: 'https://github.com/acme/repo/issues/42' }
    })
  })

  it('uses Remove-Item Env: to clear the pi prefill var on PowerShell', () => {
    // Why: `set "FOO="` is cmd-only; PowerShell parses it as the Set-Variable
    // alias and never clears the env var, so re-running pi re-prefills with
    // the stale URL. Use the portable PowerShell form instead.
    expect(
      buildAgentDraftLaunchPlan({
        agent: 'pi',
        draft: 'https://github.com/acme/repo/issues/42',
        cmdOverrides: {},
        platform: 'win32',
        windowsShell: 'powershell.exe'
      })
    ).toEqual({
      agent: 'pi',
      launchCommand: 'pi; Remove-Item Env:ORCA_PI_PREFILL -ErrorAction SilentlyContinue',
      expectedProcess: 'pi',
      env: { ORCA_PI_PREFILL: 'https://github.com/acme/repo/issues/42' }
    })
  })

  it('treats pwsh.exe as PowerShell for the prefill clear-var', () => {
    expect(
      buildAgentDraftLaunchPlan({
        agent: 'pi',
        draft: 'https://github.com/acme/repo/issues/42',
        cmdOverrides: {},
        platform: 'win32',
        windowsShell: 'pwsh.exe'
      })
    ).toEqual({
      agent: 'pi',
      launchCommand: 'pi; Remove-Item Env:ORCA_PI_PREFILL -ErrorAction SilentlyContinue',
      expectedProcess: 'pi',
      env: { ORCA_PI_PREFILL: 'https://github.com/acme/repo/issues/42' }
    })
  })

  it('returns null for an empty draft so callers fall back cleanly', () => {
    expect(
      buildAgentDraftLaunchPlan({
        agent: 'claude',
        draft: '   ',
        cmdOverrides: {},
        platform: 'darwin'
      })
    ).toBeNull()
  })

  it('honors cmdOverrides so custom Claude install paths still prefill', () => {
    expect(
      buildAgentDraftLaunchPlan({
        agent: 'claude',
        draft: 'review this',
        cmdOverrides: { claude: '/opt/anthropic/bin/claude' },
        platform: 'linux'
      })
    ).toEqual({
      agent: 'claude',
      launchCommand: "/opt/anthropic/bin/claude --prefill 'review this'",
      expectedProcess: 'claude'
    })
  })
})

describe('isShellProcess', () => {
  it('treats common shells as non-agent foreground processes', () => {
    expect(isShellProcess('bash')).toBe(true)
    expect(isShellProcess('pwsh.exe')).toBe(true)
    expect(isShellProcess('')).toBe(true)
  })

  it('does not confuse agent processes with the host shell', () => {
    expect(isShellProcess('gemini')).toBe(false)
    expect(isShellProcess('cursor-agent')).toBe(false)
  })
})
