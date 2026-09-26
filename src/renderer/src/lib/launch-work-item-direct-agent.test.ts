import { describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: { message: vi.fn() } }))
vi.mock('@/lib/agent-paste-draft', () => ({ pasteDraftWhenAgentReady: vi.fn() }))
vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: (agent: string) => agent
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, value: string, vars?: Record<string, string>) =>
    value.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => vars?.[name] ?? '')
}))

import { toast } from 'sonner'
import { track } from '@/lib/telemetry'
import {
  buildDirectWorkItemAgentStartupPlan,
  buildDirectWorkItemStartupOpts,
  notifyDirectWorkItemAgentStartTimeout
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

describe('notifyDirectWorkItemAgentStartTimeout', () => {
  it('toasts the paste hint and records the startup timeout', () => {
    notifyDirectWorkItemAgentStartTimeout('codex', true)

    expect(toast.message).toHaveBeenCalledWith(expect.stringContaining('paste the prompt'))
    expect(track).toHaveBeenCalledWith('agent_error', {
      error_class: 'unknown',
      agent_kind: 'codex'
    })
  })

  it('names the work item context for an unsubmitted paste', () => {
    notifyDirectWorkItemAgentStartTimeout('codex', false)

    expect(toast.message).toHaveBeenCalledWith(
      expect.stringContaining('paste the work item context')
    )
  })
})

// Why: the Source Control AI dialogs hide the CLI arguments field on launches that cannot apply
// it, and then send nothing. Only `undefined` reaches the global Agents arguments here — an
// empty string is an explicit "no arguments" that would silently suppress the user's setting.
describe('buildDirectWorkItemAgentStartupPlan global arguments fallback', () => {
  const withGlobalArgs = {
    ...settings,
    openAgentTabsInChatByDefault: false,
    agentDefaultArgs: { codex: '--sandbox danger-full-access' }
  }

  it('resolves the global Agents arguments when the launch names none', () => {
    const result = buildDirectWorkItemAgentStartupPlan({
      agent: 'codex',
      draftContent: 'Fix the broken checks',
      promptDelivery: 'draft',
      settings: withGlobalArgs,
      launchPlatform: 'darwin',
      nativeChatTranscriptIsLocalReadable: true
    })

    expect(result.startupPlan?.launchCommand).toContain("'--sandbox' 'danger-full-access'")
  })

  it('lets an explicit per-action value win over the global one', () => {
    const result = buildDirectWorkItemAgentStartupPlan({
      agent: 'codex',
      agentArgs: '--model gpt-5',
      draftContent: 'Fix the broken checks',
      promptDelivery: 'draft',
      settings: withGlobalArgs,
      launchPlatform: 'darwin',
      nativeChatTranscriptIsLocalReadable: true
    })

    expect(result.startupPlan?.launchCommand).toContain("'--model' 'gpt-5'")
    expect(result.startupPlan?.launchCommand).not.toContain('danger-full-access')
  })
})
