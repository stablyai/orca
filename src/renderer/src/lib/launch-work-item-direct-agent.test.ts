import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ deliverLaunchPromptToAgentTab: vi.fn() }))

vi.mock('sonner', () => ({ toast: { message: vi.fn() } }))
vi.mock('@/lib/agent-paste-draft', () => ({ pasteDraftWhenAgentReady: vi.fn() }))
vi.mock('@/lib/agent-launch-prompt-delivery', () => ({
  deliverLaunchPromptToAgentTab: mocks.deliverLaunchPromptToAgentTab
}))
vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: (agent: string) => agent
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, value: string) => value }))

import { track } from '@/lib/telemetry'
import {
  buildDirectWorkItemStartupOpts,
  pasteDirectWorkItemDraftWhenAgentReady
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
})

describe('pasteDirectWorkItemDraftWhenAgentReady onTimeout telemetry', () => {
  const plan: AgentStartupPlan = {
    agent: 'codex',
    launchCommand: "codex 'review linked issue'",
    expectedProcess: 'codex',
    followupPrompt: null,
    launchConfig: { agentArgs: '', agentEnv: {} },
    startupCommandDelivery: 'shell-ready'
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  async function runWithTimeoutReason(
    reason: 'readiness-timeout' | 'receipt-timeout'
  ): Promise<void> {
    mocks.deliverLaunchPromptToAgentTab.mockImplementation(
      async (args: { onTimeout?: (reason?: 'readiness-timeout' | 'receipt-timeout') => void }) => {
        args.onTimeout?.(reason)
        return false
      }
    )
    await pasteDirectWorkItemDraftWhenAgentReady({
      primaryTabId: 'tab-1',
      startupPlan: plan,
      content: 'do the thing',
      submit: true,
      forcePaste: true
    })
  }

  it('classifies a swallowed submit as prompt_receipt_timeout', async () => {
    await runWithTimeoutReason('receipt-timeout')
    expect(track).toHaveBeenCalledWith('agent_error', {
      error_class: 'prompt_receipt_timeout',
      agent_kind: 'codex'
    })
  })

  it('folds other startup timeouts to unknown', async () => {
    await runWithTimeoutReason('readiness-timeout')
    expect(track).toHaveBeenCalledWith('agent_error', {
      error_class: 'unknown',
      agent_kind: 'codex'
    })
  })
})
