import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { useAppStore } from '@/store'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { stubRuntimeEnvironmentBridge } from '@/runtime/runtime-environment-bridge-fixture'
import { applyWebSessionTabsSnapshot } from '@/runtime/web-session-tabs-sync/snapshot-api'
import { rememberEmptyHostAnswerForTests } from '@/runtime/web-session-tabs-sync/host-terminal-count-fixture'
import {
  resetWebRuntimeWakeTerminalRespawnForTests,
  shouldSkipWebRuntimeWakeTerminalRespawn
} from '@/runtime/web-runtime-wake-terminal-respawn'
import {
  ENV,
  WT,
  makeSnapshot,
  makeState,
  resetWebSessionTabsSyncTestState
} from '@/runtime/web-session-tabs-sync-test-harness'
import { ensureWebRuntimeWorktreeTerminalAfterWake } from './web-runtime-worktree-terminal-after-wake'

const mocks = vi.hoisted(() => ({
  supports: vi.fn(async () => true),
  createTerminal: vi.fn(async () => ({ status: 'created' }))
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  runtimeEnvironmentSupportsCapability: mocks.supports
}))
vi.mock('@/runtime/web-runtime-terminal-creation', () => ({
  createWebRuntimeSessionTerminal: mocks.createTerminal
}))
vi.mock('@/runtime/web-session-terminal-orphan-recovery', () => ({
  recoverWebSessionTerminalOrphansBeforeApply: async (
    _state: unknown,
    snapshot: RuntimeMobileSessionTabsResult
  ) => snapshot
}))

const initial = useAppStore.getState()
const worktree = makeWorktree({ id: WT, repoId: 'repo', runtimeOwnerEnvironmentId: ENV })
const agentChat: RuntimeMobileSessionTabsResult['tabs'][number] = {
  type: 'agent-session',
  id: 'agent-session:chat-1',
  sessionId: 'chat-1',
  title: 'Claude',
  agent: 'claude',
  isActive: true
}
const setup: RuntimeMobileSessionTabsResult['tabs'][number] = {
  type: 'terminal',
  id: 'setup::leaf-1',
  parentTabId: 'setup',
  leafId: 'leaf-1',
  title: 'Setup',
  terminal: 'setup-pty',
  status: 'ready',
  isActive: false
}

function seedViewer() {
  useAppStore.setState(
    {
      ...initial,
      ...makeState({ activeWorktreeId: 'other::/workspace' }),
      getKnownWorktreeById: () => worktree,
      reconcileWorktreeTabModel: () => ({ renderableTabCount: 0, activeRenderableTabId: null })
    },
    true
  )
  rememberEmptyHostAnswerForTests(ENV, WT)
}

async function wake() {
  ensureWebRuntimeWorktreeTerminalAfterWake(WT, { runtimeEnvironmentId: ENV })
  await vi.waitFor(() => expect(shouldSkipWebRuntimeWakeTerminalRespawn(WT)).toBe(false))
}

beforeEach(() => {
  resetWebSessionTabsSyncTestState()
  resetWebRuntimeWakeTerminalRespawnForTests()
  mocks.supports.mockReset().mockResolvedValue(true)
  mocks.createTerminal.mockClear()
  seedViewer()
})
afterEach(() => {
  useAppStore.setState(initial, true)
  resetWebSessionTabsSyncTestState()
  resetWebRuntimeWakeTerminalRespawnForTests()
  vi.unstubAllGlobals()
})

describe('automatic remote initialization from the host inventory', () => {
  it.each([agentChat, { ...setup, id: 'agent::leaf-1', parentTabId: 'agent', isActive: true }])(
    'waits for live creation, then materializes the actual $type outcome without seeding',
    async (agent) => {
      let snapshot = makeSnapshot([], {
        snapshotVersion: 2,
        initialSurfaceLaunch: { launchId: 'launch-1', agent: 'claude' }
      })
      const call = vi.fn(async (_request: { method: string }) => ({ ok: true, result: snapshot }))
      stubRuntimeEnvironmentBridge({ call })
      useAppStore.setState({ activeWorktreeId: WT })
      await wake()
      expect(mocks.createTerminal).not.toHaveBeenCalled()
      expect(useAppStore.getState().unifiedTabsByWorktree[WT]).toBeUndefined()
      useAppStore.setState({ activeWorktreeId: 'other::/workspace' })

      snapshot = makeSnapshot([agent, setup], {
        snapshotVersion: 3,
        activeTabId: agent.id,
        activeTabType: agent.type
      })
      await wake()
      expect(mocks.createTerminal).not.toHaveBeenCalled()
      expect(useAppStore.getState().activeWorktreeId).toBe('other::/workspace')
      expect(useAppStore.getState().unifiedTabsByWorktree[WT]).toHaveLength(2)
      expect(call.mock.calls.every(([request]) => request.method === 'session.tabs.list')).toBe(
        true
      )
      expect(useAppStore.getState().groupsByWorktree[WT]?.[0].activeTabId).toBe(
        agent.type === 'agent-session'
          ? 'structured-agent-session-chat-1'
          : toWebTerminalSurfaceTabId('agent')
      )
    }
  )

  it('seeds once after a genuine empty answer, and retains the old-host route', async () => {
    const call = vi.fn(async () => ({ ok: true, result: makeSnapshot([], { snapshotVersion: 2 }) }))
    stubRuntimeEnvironmentBridge({ call })
    ensureWebRuntimeWorktreeTerminalAfterWake(WT, { runtimeEnvironmentId: ENV })
    await wake()
    expect(call).toHaveBeenCalledOnce()
    expect(mocks.createTerminal).toHaveBeenCalledOnce()

    seedViewer()
    mocks.supports.mockResolvedValue(false)
    call.mockClear()
    await wake()
    expect(call).not.toHaveBeenCalled()
    expect(mocks.createTerminal).toHaveBeenCalledTimes(2)
  })

  it('recovers two independent viewers from final census alone and preserves a restored Setup pick', () => {
    const snapshot = makeSnapshot([agentChat, setup], {
      activeTabId: agentChat.id,
      activeTabType: 'agent-session'
    })
    const first = makeState({ activeWorktreeId: 'other::/workspace' })
    Object.assign(first, applyWebSessionTabsSnapshot(first, snapshot, ENV))
    const second = makeState()
    Object.assign(second, applyWebSessionTabsSnapshot(second, snapshot, ENV))
    const setupId = toWebTerminalSurfaceTabId('setup')
    const restored = {
      ...second,
      activeTabId: setupId,
      activeTabIdByWorktree: { [WT]: setupId },
      activeTabType: 'terminal' as const,
      activeTabTypeByWorktree: { [WT]: 'terminal' as const },
      groupsByWorktree: {
        [WT]: second.groupsByWorktree[WT].map((group) => ({ ...group, activeTabId: setupId }))
      }
    }
    Object.assign(restored, applyWebSessionTabsSnapshot(restored, snapshot, ENV))
    expect(first.activeWorktreeId).toBe('other::/workspace')
    expect(first.groupsByWorktree[WT][0].activeTabId).toBe('structured-agent-session-chat-1')
    expect(restored.groupsByWorktree[WT][0].activeTabId).toBe(setupId)
    expect(restored.activeTabId).toBe(setupId)
  })
})
