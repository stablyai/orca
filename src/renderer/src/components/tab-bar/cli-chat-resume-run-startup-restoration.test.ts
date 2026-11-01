// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { StructuredAgentSessionCreateParams } from '../../../../shared/structured-agent-session-create'

const mocks = vi.hoisted(() => ({
  sourceCapability: vi.fn(),
  closeCapability: vi.fn(),
  createCapability: vi.fn(),
  call: vi.fn(),
  toast: vi.fn(),
  activate: vi.fn(async () => true)
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  structuredAgentSessionHostSupports: mocks.closeCapability,
  supportsStructuredAgentSessionCliSource: mocks.sourceCapability,
  supportsStructuredAgentSessionCreateMessage: mocks.createCapability,
  callStructuredAgentSession: (...args: unknown[]) =>
    args[1] === 'agentSession.createSupport'
      ? Promise.resolve({ supported: true })
      : mocks.call(...args)
}))
vi.mock('@/runtime/structured-session-tab-inventory', () => ({
  readStructuredSessionTabInventory: async () => {
    throw new Error('Reply unavailable')
  }
}))
vi.mock('@/lib/structured-agent-session-create-hydration', () => ({
  publishStructuredAgentSessionCreateHydration: vi.fn()
}))
vi.mock('sonner', () => ({ toast: { error: mocks.toast } }))
vi.mock('@/lib/activate-ai-vault-structured-session', () => ({
  activateAiVaultStructuredSession: mocks.activate
}))
// Switch-on, main opens the chat's tab and its frame draws it.
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal()),
  runtimeEnvironmentSupportsCapability: async () => true
}))
vi.mock('@/runtime/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

import { getStructuredAgentSessionLaunchLifecycle } from '@/lib/structured-agent-session-launch'
import { resetStructuredAgentLaunchPersistenceForTests } from '@/lib/agent-session/launch/structured-agent-session-launch-persistence'
import {
  restoreStructuredLaunchSurfaces,
  stopStructuredLaunchSlotTracking
} from '@/lib/structured-agent-session-launch-surface'
import { resetLocalStructuredSessionVersionForTests } from '@/runtime/local-structured-session-tabs-sync/inventory-generation-fence'
import { resetWebSessionTabsSnapshotFreshnessForTests } from '@/runtime/web-session-tabs-sync/tracking-lifecycle'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { useAppStore } from '@/store'
import { resetStructuredAgentLaunchRegistryForTests } from '@/lib/agent-session/launch/structured-agent-session-launch-registry'
import { resetWebSessionFocusIntentForTests } from '@/runtime/web-session-focus-intent'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '@/store/slices/tabs-drawn-from-main.test-fixture'

const tabs = () => useAppStore.getState().unifiedTabsByWorktree['wt-1'] ?? []
let main: TabsDrawnFromMain | undefined
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  main?.close()
  main = undefined
})

beforeEach(async () => {
  vi.clearAllMocks()
  resetLocalStructuredSessionVersionForTests()
  resetWebSessionTabsSnapshotFreshnessForTests()
  stopStructuredLaunchSlotTracking()
  localStorage.clear()
  resetStructuredAgentLaunchPersistenceForTests()
  resetStructuredAgentLaunchRegistryForTests()
  resetWebSessionFocusIntentForTests()
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({ activeWorktreeId: 'wt-1' })
  mocks.closeCapability.mockResolvedValue(false)
  mocks.sourceCapability.mockResolvedValue(true)
  mocks.createCapability.mockResolvedValue(true)
  mocks.call.mockImplementation(
    async (_target, method, params: StructuredAgentSessionCreateParams) => {
      expect(method).toBe('agentSession.create')
      return { ok: true, value: { sessionId: params.envelope.sessionId, fence: 1 } }
    }
  )
  main = await drawTabsFromMain(useAppStore)
})

/** Main takes the store's current layout, as after a restart; seeding after it is invisible to main. */
async function redrawFromMain(): Promise<void> {
  main?.close()
  main = await drawTabsFromMain(useAppStore)
}

it('bounds repeated real startup restoration by its canonical population with no or one outer owner, without child-session calls', async () => {
  const { parseDesktopCreateLaunchRecord } =
    await import('@/lib/agent-session/launch/structured-agent-session-launch-record')
  const { writeStructuredAgentLaunchRecords } =
    await import('@/lib/agent-session/launch/structured-agent-session-launch-persistence')
  const counts: number[][] = []
  for (const size of [10, 100]) {
    for (const outer of [false, true]) {
      stopStructuredLaunchSlotTracking()
      localStorage.clear()
      resetStructuredAgentLaunchPersistenceForTests()
      useAppStore.setState(useAppStore.getInitialState(), true)
      useAppStore.setState({
        worktreesByRepo: { repo: [makeWorktree({ id: 'wt-1', repoId: 'repo', hostId: 'local' })] }
      })
      const ordinary = Array.from({ length: size }, (_, i) => ({
        sessionId: `ordinary-${i}`,
        executionHostId: 'local' as const,
        agent: 'claude' as const,
        lifecycle: 'visibility-unknown' as const,
        clientOperationId: `op-${i}`,
        payloadFingerprint: 'fp',
        expectedRuntimeFence: null
      }))
      const sessionId = 'claude_11111111_2222_4333_8444_555555555555'
      const sparse = parseDesktopCreateLaunchRecord({
        sessionId,
        executionHostId: 'local',
        agent: 'claude',
        lifecycle: 'visibility-unknown',
        surfaceAddress: { worktreeId: 'wt-1', precedingTabIds: [] },
        desktopCreate: {
          worktreeId: 'wt-1',
          params: {
            agent: 'claude',
            sessionId,
            surface: 'chat',
            operationId: `${Date.now()}-0123456789abcdef0123456789abcdef`,
            createIdentity: { instanceId: '94d38a16-e9db-4e86-b81d-334788958124' },
            paneKey: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d:3f2504e0-4f89-41d3-9a0c-0305e82c3301',
            target: { kind: 'create-worktree', create: { repo: 'repo', name: 'startup' } },
            prompt: { text: 'already submitted A', delivery: 'submit' }
          }
        }
      })
      if (!sparse) {
        throw new Error('outer fixture invalid')
      }
      writeStructuredAgentLaunchRecords([...ordinary, ...(outer ? [sparse] : [])])
      await redrawFromMain()
      let visits = 0
      const iterator = Map.prototype[Symbol.iterator]
      const walk = vi.spyOn(Map.prototype, Symbol.iterator).mockImplementation(function* (
        this: Map<unknown, unknown>
      ) {
        for (const entry of iterator.call(this)) {
          if (
            entry[1] &&
            typeof entry[1] === 'object' &&
            'sessionId' in entry[1] &&
            'lifecycle' in entry[1]
          ) {
            visits++
          }
          yield entry
        }
        return undefined
      })
      try {
        for (let i = 0; i < 3; i++) {
          restoreStructuredLaunchSurfaces()
          await main?.settle()
        }
        expect(visits).toBeLessThanOrEqual(30 * (size + 6))
        counts.push([size, Number(outer), visits])
        expect(tabs()).toHaveLength(Number(outer))
        if (outer) {
          expect(getStructuredAgentSessionLaunchLifecycle('wt-1', sessionId)).toBe(
            'visibility-unknown'
          )
        }
        expect(mocks.call).not.toHaveBeenCalled()
      } finally {
        walk.mockRestore()
        stopStructuredLaunchSlotTracking()
      }
    }
  }
  console.info('real startup canonical visits', JSON.stringify(counts))
})
