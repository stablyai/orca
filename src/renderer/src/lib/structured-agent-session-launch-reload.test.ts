// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-session-contracts'
import type { StructuredAgentSessionLaunchIntent } from '@/lib/launch-structured-agent-session'
import type * as RecoveryModule from '@/lib/structured-agent-session-launch-recovery'

const mocks = vi.hoisted(() => ({
  abandonIntent: vi.fn(),
  callStructuredAgentSession: vi.fn(),
  launch: vi.fn(),
  restoreIntent: vi.fn(),
  retryIntent: vi.fn(),
  seedDraft: vi.fn(),
  clearDraft: vi.fn(),
  refresh: vi.fn()
}))

vi.mock('@/lib/launch-structured-agent-session', () => {
  class StructuredAgentSessionCreateRefusalError extends Error {}
  return {
    abandonStructuredAgentSessionLaunchIntent: mocks.abandonIntent,
    createStructuredAgentSessionLaunchIntent: vi.fn(),
    launchStructuredAgentSession: mocks.launch,
    restoreStructuredAgentSessionLaunchIntent: mocks.restoreIntent,
    retryStructuredAgentSessionLaunchIntent: mocks.retryIntent,
    StructuredAgentSessionCreateRefusalError
  }
})

vi.mock('@/lib/structured-agent-session-launch-recovery', async () => {
  const actual = await vi.importActual<typeof RecoveryModule>(
    '@/lib/structured-agent-session-launch-recovery'
  )
  return { ...actual, launchAndReconcile: vi.fn(actual.launchAndReconcile) }
})

vi.mock('@/runtime/local-structured-session-tabs-sync', () => ({
  refreshLocalStructuredSessionTabs: mocks.refresh
}))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.callStructuredAgentSession
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      seedNativeChatLaunchDraft: mocks.seedDraft,
      clearNativeChatLaunchDraft: mocks.clearDraft
    })
  }
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/lib/agent-catalog', () => ({
  getAgentLabel: (agent: string) => (agent === 'codex' ? 'Codex' : 'Claude')
}))

import { retryStructuredAgentSessionLaunch } from './structured-agent-session-launch'
import { resetStructuredAgentLaunchPersistenceForTests } from './structured-agent-session-launch-persistence'
import { resetStructuredAgentLaunchRegistryForTests } from './structured-agent-session-launch-registry'

function launchIntent(worktreeId: string, sessionId: string): StructuredAgentSessionLaunchIntent {
  return {
    worktreeId,
    sessionId,
    agent: 'codex',
    params: {
      envelope: {
        sessionId,
        clientOperationId: 'operation-reloaded',
        expectedRuntimeFence: null,
        payloadFingerprint: 'fingerprint-reloaded'
      },
      worktree: `id:${worktreeId}`,
      agent: 'codex'
    }
  }
}

function publishedSnapshot(worktreeId: string, sessionId: string): RuntimeMobileSessionTabsResult {
  return {
    worktree: worktreeId,
    publicationEpoch: 'epoch-1',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: [
      {
        type: 'agent-session',
        id: 'tab-1',
        title: 'Codex',
        sessionId,
        agent: 'codex',
        isActive: true
      }
    ]
  }
}

async function flushLaunchSettlement(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await Promise.resolve()
  }
}

describe('structured agent launch reload recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    resetStructuredAgentLaunchPersistenceForTests()
    resetStructuredAgentLaunchRegistryForTests()
    mocks.callStructuredAgentSession.mockResolvedValue({ ok: true, page: { fence: 4 } })
    mocks.restoreIntent.mockImplementation(
      (args: {
        worktreeId: string
        sessionId: string
        agent: 'claude' | 'codex'
        clientOperationId: string
        payloadFingerprint: string
        expectedRuntimeFence: number | null
      }) => ({
        ...launchIntent(args.worktreeId, args.sessionId),
        agent: args.agent,
        params: {
          ...launchIntent(args.worktreeId, args.sessionId).params,
          agent: args.agent,
          envelope: {
            sessionId: args.sessionId,
            clientOperationId: args.clientOperationId,
            payloadFingerprint: args.payloadFingerprint,
            expectedRuntimeFence: args.expectedRuntimeFence
          }
        }
      })
    )
  })

  it('retries a reload-interrupted launch with the persisted operation identity', async () => {
    const worktreeId = 'wt-reload'
    const sessionId = 'codex-reload-session'
    localStorage.setItem(
      'orca:structuredAgentLaunches:v1',
      JSON.stringify([
        {
          sessionId,
          agent: 'codex',
          lifecycle: 'pending',
          clientOperationId: 'operation-reloaded',
          payloadFingerprint: 'fingerprint-reloaded',
          expectedRuntimeFence: null
        }
      ])
    )
    mocks.launch.mockResolvedValueOnce({ sessionId, fence: 4 })
    mocks.refresh
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([publishedSnapshot(worktreeId, sessionId)])

    expect(retryStructuredAgentSessionLaunch(worktreeId, sessionId)).toBe(true)
    await flushLaunchSettlement()

    expect(mocks.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        worktreeId,
        params: expect.objectContaining({
          envelope: expect.objectContaining({
            clientOperationId: 'operation-reloaded',
            payloadFingerprint: 'fingerprint-reloaded'
          })
        })
      })
    )
  })
})
