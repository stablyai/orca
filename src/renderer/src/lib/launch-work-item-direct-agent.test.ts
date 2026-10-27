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

  it('keeps a natively-prefilled draft in the terminal command', () => {
    const plan: AgentStartupPlan = {
      agent: 'claude',
      launchCommand: "claude --prefill 'https://github.com/o/r/issues/12'",
      expectedProcess: 'claude',
      followupPrompt: null,
      launchConfig: { agentArgs: '', agentEnv: {} }
    }

    const opts = buildDirectWorkItemStartupOpts('claude', plan, 'task_page')

    expect(opts.startup?.draftPrompt).toBeUndefined()
    expect(opts.startup?.command).toContain('https://github.com/o/r/issues/12')
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
  it('keeps Chat UI model preferences out of the terminal startup', () => {
    const result = buildDirectWorkItemAgentStartupPlan({
      agent: 'codex',
      draftContent: 'Review issue 42',
      promptDelivery: 'draft',
      settings,
      launchPlatform: 'darwin'
    })

    expect(result.startupPlan?.launchCommand).not.toContain("'-m'")
    expect(result.startupPlan?.launchCommand).not.toContain('model_reasoning_effort=')
    expect(result.startupPlan?.sessionOptions).toBeUndefined()
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

// Omitted hidden arguments must stay undefined to inherit settings; empty string explicitly clears them.
describe('buildDirectWorkItemAgentStartupPlan global arguments fallback', () => {
  const withGlobalArgs = {
    ...settings,
    agentDefaultArgs: { codex: '--sandbox danger-full-access' }
  }

  it('resolves the global Agents arguments when the launch names none', () => {
    const result = buildDirectWorkItemAgentStartupPlan({
      agent: 'codex',
      draftContent: 'Fix the broken checks',
      promptDelivery: 'draft',
      settings: withGlobalArgs,
      launchPlatform: 'darwin'
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
      launchPlatform: 'darwin'
    })

    expect(result.startupPlan?.launchCommand).toContain("'--model' 'gpt-5'")
    expect(result.startupPlan?.launchCommand).not.toContain('danger-full-access')
  })
})

it('keeps own permission on the direct terminal route with unrelated args and env', () => {
  const result = buildDirectWorkItemAgentStartupPlan({
    agent: 'codex',
    draftContent: 'Fix checks',
    promptDelivery: 'draft',
    launchPlatform: 'linux',
    settings: {
      agentPermissionDefault: 'full-access',
      agentDefaultArgs: { codex: '--search' },
      agentDefaultEnv: { codex: { KEEP: 'value' } }
    },
    sessionOptions: { permissionMode: 'own' }
  })
  expect(result.startupPlan?.launchCommand).not.toContain('bypass')
  expect(result.startupPlan?.launchCommand).toContain("'--search'")
  expect(result.startupPlan?.env).toEqual({ KEEP: 'value' })
})
