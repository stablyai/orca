import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { AgentStartupShell } from '../../../../shared/tui-agent-startup-shell'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { buildQuickComposerStartup } from './quick-startup-plan'

const settings = {
  ...getDefaultSettings('/tmp'),
  agentDefaultArgs: { claude: '--model sonnet' },
  agentDefaultEnv: { claude: { CLAUDE_FLAG: '1' } }
}

function build(args: {
  agent: TuiAgent | null
  prompt?: string
  draftPrompt?: string
  platform?: NodeJS.Platform
  shell?: AgentStartupShell
  isRemote?: boolean
  telemetrySource?: 'onboarding'
}) {
  return buildQuickComposerStartup({
    agent: args.agent,
    prompt: args.prompt ?? '',
    draftPrompt: args.draftPrompt,
    settings,
    platform: args.platform ?? 'darwin',
    shell: args.shell,
    isRemote: args.isRemote ?? false,
    telemetrySource: args.telemetrySource
  })
}

// Pins main's current launch behaviour as the convergence parity baseline (row 8, quick composer):
// the startup the window builds and hands to workspace creation.
describe('buildQuickComposerStartup on main', () => {
  it('claude prompt on macOS hands creation a startup command', () => {
    expect(build({ agent: 'claude', prompt: "fix Bob's bug" }).backendStartup)
      .toMatchInlineSnapshot(`
      {
        "command": "claude '--model' 'sonnet' 'fix Bob'"'"'s bug'",
        "env": {
          "CLAUDE_FLAG": "1",
        },
        "launchAgent": "claude",
        "launchConfig": {
          "agentArgs": "--model sonnet",
          "agentCommand": "claude '--model' 'sonnet'",
          "agentEnv": {
            "CLAUDE_FLAG": "1",
          },
        },
        "telemetry": {
          "agent_kind": "claude-code",
          "launch_source": "new_workspace_composer",
          "request_kind": "new",
        },
      }
    `)
  })

  it('codex prompt on macOS hands creation a startup command', () => {
    expect(build({ agent: 'codex', prompt: 'fix the bug' }).backendStartup).toMatchInlineSnapshot(`
      {
        "command": "codex '--dangerously-bypass-approvals-and-sandbox' 'fix the bug'",
        "env": {},
        "launchAgent": "codex",
        "launchConfig": {
          "agentArgs": "--dangerously-bypass-approvals-and-sandbox",
          "agentCommand": "codex '--dangerously-bypass-approvals-and-sandbox'",
          "agentEnv": {},
        },
        "startupCommandDelivery": "shell-ready",
        "telemetry": {
          "agent_kind": "codex",
          "launch_source": "new_workspace_composer",
          "request_kind": "new",
        },
      }
    `)
  })

  it('claude prompt, local Windows PowerShell hands creation a startup command', () => {
    expect(
      build({ agent: 'claude', prompt: "fix Bob's bug", platform: 'win32', shell: 'powershell' })
        .backendStartup
    ).toMatchInlineSnapshot(`
      {
        "command": "claude '--model' 'sonnet' 'fix Bob''s bug'",
        "env": {
          "CLAUDE_FLAG": "1",
        },
        "launchAgent": "claude",
        "launchConfig": {
          "agentArgs": "--model sonnet",
          "agentCommand": "claude '--model' 'sonnet'",
          "agentEnv": {
            "CLAUDE_FLAG": "1",
          },
        },
        "telemetry": {
          "agent_kind": "claude-code",
          "launch_source": "new_workspace_composer",
          "request_kind": "new",
        },
      }
    `)
  })

  it('claude prompt, local Windows cmd hands creation a startup command', () => {
    expect(
      build({ agent: 'claude', prompt: 'a & b', platform: 'win32', shell: 'cmd' }).backendStartup
    ).toMatchInlineSnapshot(`
      {
        "command": "claude "--model" "sonnet" "a ^& b"",
        "env": {
          "CLAUDE_FLAG": "1",
        },
        "launchAgent": "claude",
        "launchConfig": {
          "agentArgs": "--model sonnet",
          "agentCommand": "claude "--model" "sonnet"",
          "agentEnv": {
            "CLAUDE_FLAG": "1",
          },
        },
        "telemetry": {
          "agent_kind": "claude-code",
          "launch_source": "new_workspace_composer",
          "request_kind": "new",
        },
      }
    `)
  })

  it('claude prompt, SSH Linux hands creation a startup command', () => {
    expect(
      build({ agent: 'claude', prompt: 'fix it', platform: 'linux', isRemote: true }).backendStartup
    ).toMatchInlineSnapshot(`
      {
        "command": "claude '--model' 'sonnet' 'fix it'",
        "env": {
          "CLAUDE_FLAG": "1",
        },
        "launchAgent": "claude",
        "launchConfig": {
          "agentArgs": "--model sonnet",
          "agentCommand": "claude '--model' 'sonnet'",
          "agentEnv": {
            "CLAUDE_FLAG": "1",
          },
        },
        "telemetry": {
          "agent_kind": "claude-code",
          "launch_source": "new_workspace_composer",
          "request_kind": "new",
        },
      }
    `)
  })

  it('claude with no prompt hands creation a startup command', () => {
    expect(build({ agent: 'claude' }).backendStartup).toMatchInlineSnapshot(`
      {
        "command": "claude '--model' 'sonnet'",
        "env": {
          "CLAUDE_FLAG": "1",
        },
        "launchAgent": "claude",
        "launchConfig": {
          "agentArgs": "--model sonnet",
          "agentCommand": "claude '--model' 'sonnet'",
          "agentEnv": {
            "CLAUDE_FLAG": "1",
          },
        },
        "telemetry": {
          "agent_kind": "claude-code",
          "launch_source": "new_workspace_composer",
          "request_kind": "new",
        },
      }
    `)
  })

  it('onboarding source hands creation a startup command', () => {
    expect(build({ agent: 'claude', prompt: 'hi', telemetrySource: 'onboarding' }).backendStartup)
      .toMatchInlineSnapshot(`
      {
        "command": "claude '--model' 'sonnet' 'hi'",
        "env": {
          "CLAUDE_FLAG": "1",
        },
        "launchAgent": "claude",
        "launchConfig": {
          "agentArgs": "--model sonnet",
          "agentCommand": "claude '--model' 'sonnet'",
          "agentEnv": {
            "CLAUDE_FLAG": "1",
          },
        },
        "telemetry": {
          "agent_kind": "claude-code",
          "launch_source": "onboarding",
          "request_kind": "new",
        },
      }
    `)
  })

  it('a natively prefilled draft still hands creation a startup command', () => {
    const result = build({ agent: 'claude', draftPrompt: 'draft me' })

    expect(result.startupPlan?.draftPrompt).toBeUndefined()
    expect(result.backendStartup).toMatchInlineSnapshot(`
      {
        "command": "claude '--model' 'sonnet' --prefill 'draft me'",
        "env": {
          "CLAUDE_FLAG": "1",
        },
        "launchAgent": "claude",
        "launchConfig": {
          "agentArgs": "--model sonnet",
          "agentCommand": "claude '--model' 'sonnet'",
          "agentEnv": {
            "CLAUDE_FLAG": "1",
          },
        },
        "telemetry": {
          "agent_kind": "claude-code",
          "launch_source": "new_workspace_composer",
          "request_kind": "new",
        },
      }
    `)
  })

  it.each([
    // A draft without a native prefill, or a prompt typed after start, stays with the window.
    ['codex draft', { agent: 'codex', draftPrompt: 'draft me' }],
    ['aider prompt typed after start', { agent: 'aider', prompt: 'fix it' }]
  ] as const)('%s hands creation no startup', (_label, input) => {
    const result = build(input)

    expect(result.startupPlan).not.toBeNull()
    expect(result.backendStartup).toBeUndefined()
  })

  it('no agent builds nothing', () => {
    expect(build({ agent: null, prompt: 'ignored' })).toEqual({
      startupPlan: null,
      backendStartup: undefined,
      telemetry: null
    })
  })
})
