import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentSessionLaunchPlan } from './agent-session-launch-plan'

type BeginArgs = { beforeOpen: (sessionId: string) => boolean | void }

const mocks = vi.hoisted(() => ({
  beginStructuredAgentSessionProvisionalLaunch:
    vi.fn<(args: BeginArgs) => { sessionId: string; tab: { id: string } } | null>()
}))

vi.mock('@/lib/structured-agent-session-provisional-tab', () => ({
  beginStructuredAgentSessionProvisionalLaunch: mocks.beginStructuredAgentSessionProvisionalLaunch
}))

import { adoptAgentSessionLaunchVerdict } from './agent-session-launch-plan'
import {
  beginDirectWorkItemStructuredLaunch,
  resolveDirectWorkItemAgent
} from './launch-work-item-direct-agent-routing'
import { useAppStore } from '@/store'
import { getRuntimeAgentInventoryKey } from '@/store/slices/runtime-agent-inventory-key'
import { makeWorktree, TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { Repo } from '../../../shared/repo-types'

const structuredPlan: AgentSessionLaunchPlan = adoptAgentSessionLaunchVerdict({
  requestId: 'request-1',
  route: 'structured-native-chat',
  agent: 'codex',
  worktreeId: 'worktree-1',
  prompt: 'Fix the route',
  promptDelivery: 'draft'
})

describe('beginDirectWorkItemStructuredLaunch', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.beginStructuredAgentSessionProvisionalLaunch.mockImplementation((args) => {
      args.beforeOpen('session-1')
      return { sessionId: 'session-1', tab: { id: 'agent-session:session-1' } }
    })
  })

  it('opens the provisional chat synchronously and preserves the requested tab id', () => {
    const order: string[] = []
    mocks.beginStructuredAgentSessionProvisionalLaunch.mockImplementation((args) => {
      order.push('begin')
      args.beforeOpen('session-1')
      order.push('open')
      return { sessionId: 'session-1', tab: { id: 'agent-session:session-1' } }
    })

    expect(
      beginDirectWorkItemStructuredLaunch({
        plan: structuredPlan,
        primaryTabId: null,
        beforeOpen: (sessionId) => {
          order.push(`reveal:${sessionId}`)
          return true
        }
      })
    ).toEqual({ completed: true, structuredLaunch: true, primaryTabId: 'agent-session:session-1' })
    expect(order).toEqual(['begin', 'reveal:session-1', 'open'])
  })

  it('does not claim completion when the provisional opener is refused', () => {
    mocks.beginStructuredAgentSessionProvisionalLaunch.mockReturnValue(null)

    expect(
      beginDirectWorkItemStructuredLaunch({
        plan: structuredPlan,
        primaryTabId: 'setup-shell-tab',
        beforeOpen: vi.fn()
      })
    ).toEqual({ completed: false, structuredLaunch: true, primaryTabId: 'setup-shell-tab' })
  })

  it('skips structured opening for non-structured routes', () => {
    expect(
      beginDirectWorkItemStructuredLaunch({
        plan: adoptAgentSessionLaunchVerdict({
          ...structuredPlan,
          route: 'terminal-tui'
        }),
        primaryTabId: null,
        beforeOpen: vi.fn()
      })
    ).toEqual({ completed: false, structuredLaunch: false, primaryTabId: null })
    expect(mocks.beginStructuredAgentSessionProvisionalLaunch).not.toHaveBeenCalled()
  })
})

// Why (#29599): a paired server's new workspace picks from that workspace's agents on the server.
describe('resolveDirectWorkItemAgent', () => {
  it("asks the paired server for the new workspace's agents", async () => {
    const store = useAppStore
    const ensureRuntimeDetectedAgents = vi.fn(async (): Promise<TuiAgent[]> => ['claude'])
    const ensureDetectedAgents = vi.fn(async (): Promise<TuiAgent[]> => ['codex'])
    const repo: Repo = {
      ...TEST_REPO,
      connectionId: 'server-ssh-target',
      executionHostId: 'runtime:env-1'
    }
    store.setState({
      repos: [repo],
      worktreesByRepo: { [TEST_REPO.id]: [makeWorktree({ id: 'wt-1', repoId: TEST_REPO.id })] },
      runtimeDetectedAgentIds: { [getRuntimeAgentInventoryKey('env-1', 'wt-1')]: ['claude'] },
      settings: { ...store.getState().settings!, defaultTuiAgent: 'claude' },
      ensureRuntimeDetectedAgents,
      ensureDetectedAgents
    })

    await expect(
      resolveDirectWorkItemAgent({
        worktreeId: 'wt-1',
        repoHost: repo,
        launchConnectionId: 'server-ssh-target',
        repoConnectionId: 'server-ssh-target',
        detectedAgentsPromise: null,
        latestStore: store.getState()
      })
    ).resolves.toEqual({ agent: 'claude', unavailable: false })
    expect(ensureRuntimeDetectedAgents).toHaveBeenCalledWith('env-1', 'wt-1')
    expect(ensureDetectedAgents).not.toHaveBeenCalled()
  })
})
