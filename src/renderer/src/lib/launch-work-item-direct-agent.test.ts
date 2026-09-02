import { describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: { message: vi.fn() } }))
vi.mock('@/lib/agent-paste-draft', () => ({ pasteDraftWhenAgentReady: vi.fn() }))
vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: (agent: string) => agent
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, value: string) => value }))

import {
  buildDirectWorkItemAgentStartupPlan,
  buildDirectWorkItemStartupOpts
} from './launch-work-item-direct-agent'
import type { AgentStartupPlan } from './tui-agent-startup'

describe('buildDirectWorkItemStartupOpts', () => {
  it('preserves Codex startup command delivery for linked work-item launches', () => {
    const plan: AgentStartupPlan = {
      agent: 'codex',
      launchCommand: "codex 'review linked issue'",
      expectedProcess: 'codex',
      followupPrompt: null,
      launchConfig: { agentArgs: '', agentEnv: {} },
      startupCommandDelivery: 'shell-ready'
    }

    expect(buildDirectWorkItemStartupOpts('codex', plan, 'task_page')).toEqual({
      startup: {
        command: "codex 'review linked issue'",
        launchAgent: 'codex',
        launchConfig: { agentArgs: '', agentEnv: {} },
        startupCommandDelivery: 'shell-ready',
        telemetry: {
          agent_kind: 'codex',
          launch_source: 'task_page',
          request_kind: 'new'
        }
      }
    })
  })

  it('carries launchDraftText for a natively-prefilled draft launch', () => {
    // Why: the draft is already inside launchCommand, so draftPrompt stays unset
    // and launchDraftText is the only signal the view-mode gate can read.
    const plan: AgentStartupPlan = {
      agent: 'claude',
      launchCommand: "claude --prefill 'https://github.com/o/r/issues/12'",
      expectedProcess: 'claude',
      followupPrompt: null,
      launchConfig: { agentArgs: '', agentEnv: {} }
    }

    const opts = buildDirectWorkItemStartupOpts(
      'claude',
      plan,
      'task_page',
      'https://github.com/o/r/issues/12'
    )

    expect(opts.startup?.draftPrompt).toBeUndefined()
    expect(opts.startup?.launchDraftText).toBe('https://github.com/o/r/issues/12')
  })
})

const settings = {
  agentCmdOverrides: {},
  agentDefaultArgs: {},
  agentDefaultEnv: {},
  experimentalNativeChat: true,
  nativeChatSessionOptions: {
    codex: {
      model: 'gpt-5.2-codex',
      valuesByModel: { 'gpt-5.2-codex': { effort: 'medium' } }
    }
  }
}

describe('buildDirectWorkItemAgentStartupPlan', () => {
  it('omits native-chat preferences when the new workspace opens in terminal mode', () => {
    const result = buildDirectWorkItemAgentStartupPlan({
      agent: 'codex',
      draftContent: 'Review issue 42',
      promptDelivery: 'draft',
      settings: { ...settings, openAgentTabsInChatByDefault: false },
      launchPlatform: 'darwin',
      nativeChatTranscriptIsLocalReadable: true
    })

    expect(result.startupPlan?.launchCommand).not.toContain("'-m'")
    expect(result.startupPlan?.sessionOptions).toBeUndefined()
  })

  it('applies native-chat preferences when the new workspace opens in chat', () => {
    const result = buildDirectWorkItemAgentStartupPlan({
      agent: 'codex',
      draftContent: 'Review issue 42',
      promptDelivery: 'draft',
      settings: { ...settings, openAgentTabsInChatByDefault: true },
      launchPlatform: 'darwin',
      nativeChatTranscriptIsLocalReadable: true
    })

    expect(result.startupPlan?.launchCommand).toContain("'-m' 'gpt-5.2-codex'")
    expect(result.startupPlan?.sessionOptions).toEqual({
      model: 'gpt-5.2-codex',
      effort: 'medium'
    })
  })
})
