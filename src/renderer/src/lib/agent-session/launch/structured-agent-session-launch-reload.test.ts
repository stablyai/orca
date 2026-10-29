// @vitest-environment happy-dom

import type * as LaunchErrors from '@/lib/structured-agent-session-launch-errors'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../../../shared/runtime-session-contracts'
import type { StructuredAgentSessionLaunchIntent } from '@/lib/launch-structured-agent-session'
import type * as RecoveryModule from '@/lib/agent-session/launch/structured-agent-session-launch-recovery'

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

const launchErrorMocks = vi.hoisted(() => {
  class StructuredAgentSessionCreateRefusalError extends Error {}
  return { StructuredAgentSessionCreateRefusalError }
})

vi.mock('@/lib/structured-agent-session-launch-errors', async () => ({
  ...(await vi.importActual<typeof LaunchErrors>('@/lib/structured-agent-session-launch-errors')),
  ...launchErrorMocks
}))

vi.mock('@/lib/structured-agent-session-launch-create-call', () => ({
  launchStructuredAgentSession: mocks.launch
}))

vi.mock('@/lib/launch-structured-agent-session', () => {
  return {
    abandonStructuredAgentSessionLaunchIntent: mocks.abandonIntent,
    createStructuredAgentSessionLaunchIntent: vi.fn(),
    launchStructuredAgentSession: mocks.launch,
    restoreStructuredAgentSessionLaunchIntent: mocks.restoreIntent,
    retryStructuredAgentSessionLaunchIntent: mocks.retryIntent,
    StructuredAgentSessionCreateRefusalError:
      launchErrorMocks.StructuredAgentSessionCreateRefusalError
  }
})

vi.mock('@/lib/agent-session/launch/structured-agent-session-launch-recovery', async () => {
  const actual = await vi.importActual<typeof RecoveryModule>(
    '@/lib/agent-session/launch/structured-agent-session-launch-recovery'
  )
  return { ...actual, launchAndReconcile: vi.fn(actual.launchAndReconcile) }
})

vi.mock('@/runtime/local-structured-session-tabs-sync/inventory-refresh', () => ({
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

import { retryStructuredAgentSessionLaunch } from '../../structured-agent-session-launch'
import { resetStructuredAgentLaunchPersistenceForTests } from './structured-agent-session-launch-persistence'
import {
  resetStructuredAgentLaunchRegistryForTests,
  getStructuredLaunchStateBySessionId
} from './structured-agent-session-launch-registry'

function launchIntent(worktreeId: string, sessionId: string): StructuredAgentSessionLaunchIntent {
  return {
    worktreeId,
    executionHostId: 'local',
    target: { kind: 'local' },
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
        explicitLaunchOptions?: Readonly<Record<string, string>>
        optionsMode?: 'replace-model-selection'
        options?: Readonly<Record<string, string>>
      }) => ({
        ...launchIntent(args.worktreeId, args.sessionId),
        agent: args.agent,
        explicitLaunchOptions: args.explicitLaunchOptions,
        params: {
          ...launchIntent(args.worktreeId, args.sessionId).params,
          agent: args.agent,
          optionsMode: args.optionsMode,
          options: args.options,
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
          explicitLaunchOptions: { model: 'action-model', fastMode: 'false' },
          optionsMode: 'replace-model-selection',
          options: { model: 'frozen-model', effort: 'high' },
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
    expect(getStructuredLaunchStateBySessionId(sessionId)?.selection).toMatchObject({
      explicit: { model: 'action-model', fastMode: 'false' },
      held: {}
    })
    await flushLaunchSettlement()

    expect(mocks.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        worktreeId,
        explicitLaunchOptions: { model: 'action-model', fastMode: 'false' },
        params: expect.objectContaining({
          optionsMode: 'replace-model-selection',
          options: { model: 'frozen-model', effort: 'high' },
          envelope: expect.objectContaining({
            clientOperationId: 'operation-reloaded',
            payloadFingerprint: 'fingerprint-reloaded'
          })
        })
      }),
      expect.any(Function),
      true,
      expect.any(Function)
    )
  })
})
