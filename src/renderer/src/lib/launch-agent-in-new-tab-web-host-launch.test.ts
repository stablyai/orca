import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { PAIRED_TAB_CASES, PAIRED_WORKSPACE } from './launch-parity-paired-tab.test-cases'
import {
  launchWorkspaceState,
  perClientLoader,
  type LaunchStoreHolder
} from './launch-parity-renderer.test-fixture'
import { launchWorkspaceId } from '../../../shared/launch-parity-window-request.test-fixture'

const mocks = vi.hoisted(() => ({
  createWebRuntimeSessionTerminal: vi.fn(),
  createWebRuntimeAgentSessionTerminal: vi.fn(),
  createWebRuntimeAgentSessionTerminalWithLaunchDraft: vi.fn()
}))
const holder = vi.hoisted((): LaunchStoreHolder => ({ store: null }))

vi.mock('@/store', async () =>
  (await import('@/lib/launch-parity-renderer.test-fixture')).launchStoreModuleMock(holder)
)
vi.mock('sonner', () => ({ toast: { message: vi.fn(), error: vi.fn() } }))
vi.mock('@/runtime/web-runtime-session', () => ({
  ...mocks,
  isWebRuntimeSessionActive: vi.fn(() => true),
  isWebTerminalSurfaceTabId: vi.fn(() => false)
}))

const load = perClientLoader(async () => ({ launch: await import('./launch-agent-in-new-tab') }))

// Pins main's current launch behaviour as the convergence parity baseline (row 7, producer half):
// the exact launch object a typed-prompt new tab hands the paired-host creator.
describe('row 7: launchAgentInNewTab paired web host launch on main', () => {
  beforeAll(async () => {
    await load('darwin')
  }, 240_000)
  afterEach(() => vi.unstubAllGlobals())

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.createWebRuntimeSessionTerminal.mockResolvedValue({ status: 'created' })
    mocks.createWebRuntimeAgentSessionTerminalWithLaunchDraft.mockResolvedValue({
      status: 'created'
    })
  })

  it.each(PAIRED_TAB_CASES)('$name', async ({ producer, creator, launch }) => {
    const { launch: producerModule, createStore } = await load('darwin')
    const store = createStore()
    holder.store = store
    store.setState(launchWorkspaceState(PAIRED_WORKSPACE))

    const result = producerModule.launchAgentInNewTab({
      requestId: 'request-1',
      worktreeId: launchWorkspaceId(PAIRED_WORKSPACE),
      groupId: 'group-1',
      ...producer
    })

    expect(result?.surface).toStrictEqual({ kind: 'host-published' })
    expect(result?.pasteDraftAfterLaunch).toBe(false)
    const used =
      creator === 'session'
        ? mocks.createWebRuntimeSessionTerminal
        : mocks.createWebRuntimeAgentSessionTerminalWithLaunchDraft
    expect(used.mock.calls).toStrictEqual([[launch]])
    expect(mocks.createWebRuntimeAgentSessionTerminal).not.toHaveBeenCalled()
    // The paired host owns the tab: nothing is created or queued locally. A draft's chat copy is
    // seeded by the launch-draft creator once the host answers (pinned in the wire suite).
    expect(store.getState().tabsByWorktree[launchWorkspaceId(PAIRED_WORKSPACE)] ?? []).toEqual([])
    expect(store.getState().pendingStartupByTabId).toEqual({})
  })
})
