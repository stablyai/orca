import { describe, expect, it, vi } from 'vitest'

vi.mock('sonner', () => ({ toast: { message: vi.fn() } }))
vi.mock('@/lib/agent-paste-draft', () => ({ pasteDraftWhenAgentReady: vi.fn() }))
vi.mock('@/lib/telemetry', () => ({
  track: vi.fn(),
  tuiAgentToAgentKind: (agent: string) => agent
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, value: string) => value }))

import { buildDirectWorkItemStartupOpts } from './launch-work-item-direct-agent'
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
