import { describe, expect, it } from 'vitest'
import {
  buildAgentDraftLaunchPlan,
  buildAgentStartupPlan,
  isShellProcess
} from './tui-agent-startup'
import { resolveTuiAgentLaunchArgs } from '../../../shared/tui-agent-launch-defaults'

const emptyLaunchConfig = (agentCommand: string) => ({
  agentCommand,
  agentArgs: '',
  agentEnv: {}
})

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
      followupPrompt: null,
      launchConfig: emptyLaunchConfig('claude')
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
      followupPrompt: null,
      launchConfig: emptyLaunchConfig('gemini')
    })
  })

  it('uses Antigravity interactive prompt mode with the agy binary', () => {
    expect(
      buildAgentStartupPlan({
        agent: 'antigravity',
        prompt: 'Investigate this regression',
        cmdOverrides: {},
        platform: 'linux'
      })
    ).toEqual({
      agent: 'antigravity',
      launchCommand: "agy --prompt-interactive 'Investigate this regression'",
      expectedProcess: 'agy',
      followupPrompt: null,
      launchConfig: emptyLaunchConfig('agy')
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
      followupPrompt: 'Refactor the parser',
      launchConfig: emptyLaunchConfig('aider')
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
      followupPrompt: 'Add tests for the parser',
      launchConfig: emptyLaunchConfig('autohand')
    })
  })

  it('launches Ante first and injects the draft prompt after startup', () => {
    expect(
      buildAgentStartupPlan({
        agent: 'ante',
        prompt: 'Summarize the failing tests',
        cmdOverrides: {},
        platform: 'linux'
      })
    ).toEqual({
      agent: 'ante',
      launchCommand: 'ante',
      expectedProcess: 'ante',
      followupPrompt: 'Summarize the failing tests',
      launchConfig: emptyLaunchConfig('ante')
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
      followupPrompt: null,
      launchConfig: emptyLaunchConfig('cursor-agent')
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
      followupPrompt: null,
      launchConfig: emptyLaunchConfig('/opt/factory/bin/droid')
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
      followupPrompt: null,
      launchConfig: emptyLaunchConfig('copilot')
    })
  })

  it('launches Grok first and injects the prompt after startup', () => {
    expect(
      buildAgentStartupPlan({
        agent: 'grok',
        prompt: 'Trace the failing test',
        cmdOverrides: {},
        platform: 'linux'
      })
    ).toEqual({
      agent: 'grok',
      launchCommand: 'grok',
      expectedProcess: 'grok',
      followupPrompt: 'Trace the failing test',
      launchConfig: emptyLaunchConfig('grok')
    })
  })

  it('launches Devin first and injects the prompt after startup', () => {
    expect(
      buildAgentStartupPlan({
        agent: 'devin',
        prompt: 'Trace the failing test',
        cmdOverrides: {},
        agentArgs: resolveTuiAgentLaunchArgs('devin', null),
        platform: 'linux'
      })
    ).toEqual({
      agent: 'devin',
      launchCommand: "devin '--permission-mode' 'bypass'",
      expectedProcess: 'devin',
      followupPrompt: 'Trace the failing test',
      launchConfig: {
        agentCommand: "devin '--permission-mode' 'bypass'",
        agentArgs: '--permission-mode bypass',
        agentEnv: {}
      }
    })
  })

  it('launches Command Code by its unambiguous binary with a positional prompt', () => {
    expect(
      buildAgentStartupPlan({
        agent: 'command-code',
        prompt: 'Fix the issue',
        cmdOverrides: {},
        platform: 'win32'
      })
    ).toEqual({
      agent: 'command-code',
      launchCommand: "command-code --trust 'Fix the issue'",
      expectedProcess: 'command-code',
      followupPrompt: null,
      launchConfig: emptyLaunchConfig('command-code --trust')
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
      followupPrompt: null,
      launchConfig: emptyLaunchConfig('copilot')
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
      expectedProcess: 'claude',
      launchConfig: emptyLaunchConfig('claude')
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
      env: { ORCA_PI_PREFILL: 'https://github.com/acme/repo/issues/42' },
      launchConfig: emptyLaunchConfig('pi')
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
      expectedProcess: 'claude',
      launchConfig: emptyLaunchConfig('/opt/anthropic/bin/claude')
    })
  })

  it('uses OpenClaude native prefill support for draft launches', () => {
    expect(
      buildAgentDraftLaunchPlan({
        agent: 'openclaude',
        draft: 'review this',
        cmdOverrides: {},
        platform: 'linux'
      })
    ).toEqual({
      agent: 'openclaude',
      launchCommand: "openclaude --prefill 'review this'",
      expectedProcess: 'openclaude',
      launchConfig: emptyLaunchConfig('openclaude')
    })
  })
})

describe('isShellProcess', () => {
  it('treats common shells as non-agent foreground processes', () => {
    expect(isShellProcess('bash')).toBe(true)
    expect(isShellProcess('C:\\Program Files\\Git\\bin\\bash.exe')).toBe(true)
    expect(isShellProcess('pwsh.exe')).toBe(true)
    expect(isShellProcess('/bin/zsh')).toBe(true)
    expect(isShellProcess('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')).toBe(
      true
    )
    expect(isShellProcess('')).toBe(true)
  })

  it('does not confuse agent processes with the host shell', () => {
    expect(isShellProcess('gemini')).toBe(false)
    expect(isShellProcess('cursor-agent')).toBe(false)
  })
})
