import { describe, expect, it } from 'vitest'
import {
  dropStaleResumePermissionEscalation,
  resolveResumeLaunchInputs
} from './agent-resume-permission-drop'

const CLAUDE_YOLO_COMMAND = "claude '--dangerously-skip-permissions'"

function dropForClaude(args: {
  agentCommand?: string
  agentArgs: string
  currentAgentArgs: string
  cmdOverride?: string
  platform?: NodeJS.Platform
}) {
  return dropStaleResumePermissionEscalation({
    agent: 'claude',
    launchConfig: {
      ...(args.agentCommand !== undefined ? { agentCommand: args.agentCommand } : {}),
      agentArgs: args.agentArgs,
      agentEnv: {}
    },
    ...(args.cmdOverride !== undefined ? { cmdOverride: args.cmdOverride } : {}),
    currentAgentArgs: args.currentAgentArgs,
    currentAgentEnv: {},
    platform: args.platform ?? 'darwin'
  })
}

describe('dropStaleResumePermissionEscalation', () => {
  it('drops an escalation the current settings no longer grant', () => {
    expect(
      dropForClaude({
        agentCommand: CLAUDE_YOLO_COMMAND,
        agentArgs: '--dangerously-skip-permissions',
        currentAgentArgs: ''
      })
    ).toEqual({ agentCommand: 'claude', agentArgs: '', agentEnv: {} })
  })

  it('keeps the escalation while the current settings still grant it', () => {
    expect(
      dropForClaude({
        agentCommand: CLAUDE_YOLO_COMMAND,
        agentArgs: '--dangerously-skip-permissions',
        currentAgentArgs: '--dangerously-skip-permissions'
      })
    ).toEqual({
      agentCommand: CLAUDE_YOLO_COMMAND,
      agentArgs: '--dangerously-skip-permissions',
      agentEnv: {}
    })
  })

  it('keeps the escalation carried by the agent command override', () => {
    expect(
      dropForClaude({
        agentCommand: "my-claude '--dangerously-skip-permissions'",
        agentArgs: '--dangerously-skip-permissions',
        currentAgentArgs: '',
        cmdOverride: 'my-claude --dangerously-skip-permissions'
      })
    ).toEqual({
      agentCommand: "my-claude '--dangerously-skip-permissions'",
      agentArgs: '--dangerously-skip-permissions',
      agentEnv: {}
    })
  })

  it('preserves the launch flags that are not permission escalations', () => {
    expect(
      dropForClaude({
        agentCommand: "claude '--dangerously-skip-permissions' '--model' 'opus'",
        agentArgs: '--dangerously-skip-permissions --model opus',
        currentAgentArgs: '--model opus'
      })
    ).toEqual({
      agentCommand: "claude '--model' 'opus'",
      agentArgs: '--model opus',
      agentEnv: {}
    })
  })

  it('drops every occurrence a recorded launch accumulated', () => {
    expect(
      dropForClaude({
        agentCommand:
          "claude '--dangerously-skip-permissions' '--dangerously-skip-permissions' '--model' 'opus'",
        agentArgs: '--dangerously-skip-permissions --dangerously-skip-permissions --model opus',
        currentAgentArgs: '--model opus'
      })
    ).toEqual({
      agentCommand: "claude '--model' 'opus'",
      agentArgs: '--model opus',
      agentEnv: {}
    })
  })

  it('never adds an escalation the recorded launch did not have', () => {
    expect(
      dropForClaude({
        agentCommand: 'claude',
        agentArgs: '',
        currentAgentArgs: '--dangerously-skip-permissions'
      })
    ).toEqual({ agentCommand: 'claude', agentArgs: '', agentEnv: {} })
  })

  it('leaves a sequence behind the agent terminator alone', () => {
    const agentCommand = "claude '--' '--dangerously-skip-permissions'"
    expect(
      dropForClaude({
        agentCommand,
        agentArgs: '-- --dangerously-skip-permissions',
        currentAgentArgs: ''
      })
    ).toEqual({ agentCommand, agentArgs: '-- --dangerously-skip-permissions', agentEnv: {} })
  })

  it('fails open on a recorded command it cannot tokenize', () => {
    const agentCommand = "claude '--dangerously-skip-permissions"
    expect(dropForClaude({ agentCommand, agentArgs: '', currentAgentArgs: '' })).toEqual({
      agentCommand,
      agentArgs: '',
      agentEnv: {}
    })
  })

  it('drops the escalation from an args-only launch config', () => {
    expect(
      dropForClaude({ agentArgs: '--dangerously-skip-permissions', currentAgentArgs: '' })
    ).toEqual({ agentArgs: '', agentEnv: {} })
  })

  it('fails open on a recorded command carrying shell syntax between tokens', () => {
    const agentCommand = "claude '--dangerously-skip-permissions' && echo done"
    expect(dropForClaude({ agentCommand, agentArgs: '', currentAgentArgs: '' })).toEqual({
      agentCommand,
      agentArgs: '',
      agentEnv: {}
    })
  })

  it('fails open when a newline separates the recorded tokens', () => {
    const agentCommand = "claude\n'--dangerously-skip-permissions'"
    expect(dropForClaude({ agentCommand, agentArgs: '', currentAgentArgs: '' })).toEqual({
      agentCommand,
      agentArgs: '',
      agentEnv: {}
    })
  })

  it('quotes-aware drops the escalation from a PowerShell recorded command', () => {
    expect(
      dropForClaude({
        agentCommand: "claude '--dangerously-skip-permissions'",
        agentArgs: '--dangerously-skip-permissions',
        currentAgentArgs: '',
        platform: 'win32'
      })
    ).toEqual({ agentCommand: 'claude', agentArgs: '', agentEnv: {} })
  })

  it('drops a multi-token escalation', () => {
    expect(
      dropStaleResumePermissionEscalation({
        agent: 'qwen-code',
        launchConfig: {
          agentCommand: "qwen '--approval-mode' 'yolo'",
          agentArgs: '--approval-mode yolo',
          agentEnv: {}
        },
        currentAgentArgs: '',
        currentAgentEnv: {},
        platform: 'darwin'
      })
    ).toEqual({ agentCommand: 'qwen', agentArgs: '', agentEnv: {} })
  })

  it('drops a stale escalation env var', () => {
    expect(
      dropStaleResumePermissionEscalation({
        agent: 'goose',
        launchConfig: { agentCommand: 'goose', agentArgs: '', agentEnv: { GOOSE_MODE: 'auto' } },
        currentAgentArgs: '',
        currentAgentEnv: {},
        platform: 'darwin'
      })
    ).toEqual({ agentCommand: 'goose', agentArgs: '', agentEnv: {} })
  })

  it('keeps an escalation env var the current settings still grant', () => {
    expect(
      dropStaleResumePermissionEscalation({
        agent: 'goose',
        launchConfig: { agentCommand: 'goose', agentArgs: '', agentEnv: { GOOSE_MODE: 'auto' } },
        currentAgentArgs: '',
        currentAgentEnv: { GOOSE_MODE: 'auto' },
        platform: 'darwin'
      })
    ).toEqual({ agentCommand: 'goose', agentArgs: '', agentEnv: { GOOSE_MODE: 'auto' } })
  })

  it('keeps a non-escalation env var the pane recorded', () => {
    expect(
      dropStaleResumePermissionEscalation({
        agent: 'goose',
        launchConfig: {
          agentCommand: 'goose',
          agentArgs: '',
          agentEnv: { GOOSE_MODE: 'auto', GOOSE_MODEL: 'gpt-5' }
        },
        currentAgentArgs: '',
        currentAgentEnv: {},
        platform: 'darwin'
      })
    ).toEqual({ agentCommand: 'goose', agentArgs: '', agentEnv: { GOOSE_MODEL: 'gpt-5' } })
  })
})

describe('resolveResumeLaunchInputs', () => {
  it('falls back to the current settings when the pane recorded no launch config', () => {
    expect(
      resolveResumeLaunchInputs({
        agent: 'claude',
        launchConfig: undefined,
        settings: { agentDefaultArgs: { claude: '--model opus' } },
        platform: 'darwin'
      })
    ).toEqual({ launchConfig: undefined, agentArgs: '--model opus', agentEnv: {} })
  })

  it('reports the de-escalated recorded config as the resume inputs', () => {
    expect(
      resolveResumeLaunchInputs({
        agent: 'claude',
        launchConfig: {
          agentCommand: "claude '--dangerously-skip-permissions'",
          agentArgs: '--dangerously-skip-permissions',
          agentEnv: {}
        },
        settings: { agentDefaultArgs: { claude: '' } },
        platform: 'darwin'
      })
    ).toEqual({
      launchConfig: { agentCommand: 'claude', agentArgs: '', agentEnv: {} },
      agentArgs: '',
      agentEnv: {}
    })
  })

  it('keeps the recorded escalation when the command override still carries it', () => {
    const launchConfig = {
      agentCommand: "my-claude '--dangerously-skip-permissions'",
      agentArgs: '--dangerously-skip-permissions',
      agentEnv: {}
    }
    expect(
      resolveResumeLaunchInputs({
        agent: 'claude',
        launchConfig,
        settings: {
          agentDefaultArgs: { claude: '' },
          agentCmdOverrides: { claude: 'my-claude --dangerously-skip-permissions' }
        },
        platform: 'darwin'
      })
    ).toEqual({
      launchConfig,
      agentArgs: '--dangerously-skip-permissions',
      agentEnv: {}
    })
  })
})
