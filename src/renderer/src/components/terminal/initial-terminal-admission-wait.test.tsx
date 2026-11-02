// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'
import type { AppState } from '@/store/types'
import type { StructuredAgentLaunchSettlement } from '@/lib/structured-agent-launch-settlement'

const mocks = vi.hoisted(() => {
  const answers: ((support: unknown) => void)[] = []
  return {
    gate: vi.fn(),
    createTab: vi.fn(),
    createUnifiedTab: vi.fn<AppState['createUnifiedTab']>(),
    begin: vi.fn<AgentSessionLaunchPlan['begin']>(),
    answers
  }
})

const owner = vi.hoisted((): { store: ReturnType<typeof createTestStore> | null } => ({
  store: null
}))
vi.mock('@/store', async () => {
  const module = (await import('@/lib/launch-parity-renderer.test-fixture')).launchStoreModuleMock(
    owner
  )
  return {
    useAppStore: Object.assign(
      (selector: (state: AppState) => unknown) => owner.store!(selector),
      module.useAppStore
    )
  }
})
vi.mock('@/lib/worktree-agent-activation-gate', () => ({ gateWorktreeAgentActivation: mocks.gate }))
vi.mock('@/lib/resume-sleeping-agent-session', () => ({
  resumeSleepingAgentSessionsForWorktree: vi.fn()
}))
vi.mock('@/lib/workspace-terminal-host-authority', () => ({
  createWorkspaceTerminalHostAuthoritySelector: () => () => 'none'
}))
vi.mock('../terminal-pane/terminal-parked-tab-watchers', () => ({
  pruneParkedTerminalWatchers: vi.fn(),
  terminalWatcherLiveWorkspaceIds: () => new Set(),
  syncParkedTerminalTabWatchersForWorkspaces: vi.fn(),
  disposeAllParkedTerminalWatchers: vi.fn()
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: (_target: unknown, method: string) =>
    method === 'agentSession.createSupport'
      ? new Promise((resolve) => {
          const answer = (support: unknown) => {
            mocks.answers.splice(mocks.answers.indexOf(answer), 1)
            resolve(support)
          }
          mocks.answers.push(answer)
        })
      : new Promise(() => undefined)
}))

// Main answers the window's chat-tab open (switch-on builds).
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

vi.mock('@/runtime/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)

import { createTestStore, makeWorktree, seedStore } from '@/store/slices/store-test-helpers'
import {
  drawTabsFromMain,
  type TabsDrawnFromMain
} from '@/store/slices/tabs-drawn-from-main.test-fixture'
import { isPendingTab } from '@/runtime/layout-owner-pending-tabs'
import { useTerminalWatcherEffects } from '../use-terminal-watcher-effects'
import { beginStructuredAgentSessionProvisionalLaunch } from '@/lib/agent-session/structured-agent-session-provisional-tab'
import { isEmptyWorkspaceDefaultSurfacePending } from '@/lib/empty-workspace-default-surface-claims'
import type { AgentSessionLaunchPlan } from '@/lib/agent-session-launch-plan'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root | undefined

let main: TabsDrawnFromMain
let warnings: MockInstance<typeof console.warn>
const owned: {
  launch: NonNullable<ReturnType<typeof beginStructuredAgentSessionProvisionalLaunch>>
  done: boolean
}[] = []
const begins: { finish: () => void; cancel: ReturnType<typeof vi.fn> }[] = []
beforeEach(async () => {
  vi.resetAllMocks()
  owner.store = createTestStore()
  seedStore(owner.store, {
    worktreesByRepo: { repo: [makeWorktree({ id: 'wt-1', repoId: 'repo' })] },
    activeWorktreeId: 'wt-1'
  })
  mocks.createUnifiedTab.mockImplementation(owner.store.getState().createUnifiedTab)
  owner.store.setState({ createUnifiedTab: mocks.createUnifiedTab })
  expect(owner.store.getState().readLocalAgentInventory('wt-1')).toEqual({
    ids: null,
    state: 'pending'
  })
  main = await drawTabsFromMain(owner.store)
  warnings = vi.spyOn(console, 'warn')
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  for (const entry of owned) {
    if (!entry.done) {
      entry.launch.cancel()
    }
  }
  while (mocks.answers.length) {
    mocks.answers[0]!({ supported: false })
  }
  for (const begin of begins.splice(0)) {
    begin.finish()
  }
  await Promise.all(owned.splice(0).map(({ launch }) => launch.settlement))
  await main.settle()
  expect(mocks.answers).toEqual([])
  expect(begins).toEqual([])
  expect(layoutApplyTestTransport.pendingCount).toBe(0)
  expect(
    warnings.mock.calls.filter(
      ([message]) => message === '[layout-owner] pending tab waiter threw:'
    )
  ).toEqual([])
  main.close()
  vi.restoreAllMocks()
  owner.store = null
})

function launchChat(args: Parameters<typeof beginStructuredAgentSessionProvisionalLaunch>[0]) {
  const launch = beginStructuredAgentSessionProvisionalLaunch(args)
  if (!launch) {
    throw new Error('Expected admitted launch handle')
  }
  const entry = { launch, done: false }
  owned.push(entry)
  void launch.settlement.then(() => {
    entry.done = true
  })
  return launch
}

async function finishChat(launch: NonNullable<ReturnType<typeof launchChat>>): Promise<void> {
  const begin = begins.pop()!
  begin.finish()
  await expect(launch.settlement).resolves.toEqual({ kind: 'structured', sessionId: 'claude_1' })
  await main.settle()
  expect(begin.cancel).not.toHaveBeenCalled()
  const tab = owner
    .store!.getState()
    .unifiedTabsByWorktree['wt-1']?.find((row) => row.entityId === 'claude_1')
  expect(tab).toBeDefined()
  expect(owner.store!.getState().getTab(tab!.id)).toBe(tab)
  expect(isPendingTab(tab!.id)).toBe(false)
  expect(isEmptyWorkspaceDefaultSurfacePending('wt-1')).toBe(false)
}

/** No shell created here or (switch-on) asked of main. */
function expectNoShell(): void {
  expect(mocks.createTab).not.toHaveBeenCalled()
  expect(layoutApplyTestTransport.sentOfType('createTerminalTab')).toEqual([])
}

/** The watcher's shell create: here, or (switch-on) sent to main, whose frame draws it. */
async function expectShellCreatedOnce(): Promise<void> {
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    await layoutApplyTestTransport.settle()
    expect(layoutApplyTestTransport.sentOfType('createTerminalTab')).toEqual([
      expect.objectContaining({ workspace: 'wt-1' })
    ])
    return
  }
  expect(mocks.createTab).toHaveBeenCalledOnce()
}

/** Observe the original create/open request count; finishChat verifies the actual drawn row. */
async function expectChatOpenedOnce(): Promise<void> {
  if (ORCA_LAYOUT_OWNER_IS_MAIN) {
    await layoutApplyTestTransport.settle()
    expect(layoutApplyTestTransport.sentOfType('openAgentSessionTab')).toEqual([
      expect.objectContaining({ workspace: 'wt-1', sessionId: 'claude_1' })
    ])
    expect(mocks.createUnifiedTab).not.toHaveBeenCalled()
    return
  }
  expect(mocks.createUnifiedTab).toHaveBeenCalledOnce()
}

function Watcher(): null {
  useTerminalWatcherEffects({
    activeWorktreeId: 'wt-1',
    workspaceSessionReady: true,
    terminalStartupRestorationReady: true,
    hydrationSucceeded: false,
    workspaceSurfaceIds: [],
    tabsByWorktree: {},
    createTab: mocks.createTab,
    reconcileWorktreeTabModel: () => ({ renderableTabCount: 0, activeRenderableTabId: null }),
    activationDeferredMountTabIdsByWorktreeRef: { current: new Map() },
    activeTabId: null,
    activeTabIdByWorktree: {},
    activeView: 'terminal',
    activityTerminalPortals: [],
    anyMountedWorktreeHasLayout: false,
    backgroundMountRevision: 0,
    effectiveParkedTerminalWorktreeIds: new Set(),
    evictionExemptTerminalTabIds: new Set(),
    getEffectiveLayoutForWorktree: () => undefined,
    groupsByWorktree: {},
    measurableBackgroundWorktreeIdsRef: { current: new Set() },
    mountedWorktreeIdsRef: { current: new Set() },
    pairedRuntimeParkingEnvironmentIds: new Set(),
    pendingStartupByTabId: {},
    renderedActiveWorktreeId: 'wt-1',
    startupTerminalTabHold: null,
    terminalParkingEnabled: false,
    terminalProviderSnapshotCapabilityRevision: 0,
    terminalSshParkingEnabled: false,
    terminalTitleSnapshotAuthorityEnabled: false
  })
  return null
}

function localChatPlan(): AgentSessionLaunchPlan {
  mocks.begin.mockImplementation(() => {
    const result = Promise.withResolvers<StructuredAgentLaunchSettlement>()
    const cancel = vi.fn()
    begins.push({
      finish: () => result.resolve({ kind: 'structured', sessionId: 'claude_1' }),
      cancel
    })
    return { sessionId: 'claude_1', executionHostId: 'local', settlement: result.promise, cancel }
  })
  return {
    route: 'structured-native-chat',
    requestId: 'request-1',
    agent: 'claude',
    worktreeId: 'wt-1',
    executionHostId: 'local',
    begin: mocks.begin,
    launch: vi.fn()
  }
}

function gateAnsweredLater(): {
  gate: Promise<'empty'>
  finish: () => void
} {
  let finish!: () => void
  const gate = new Promise<'empty'>((resolve) => {
    finish = () => resolve('empty')
  })
  mocks.gate.mockReturnValue(gate)
  return { gate, finish }
}

// While admission waits, no launch record exists yet; passive seeding must not add Terminal 1 beside the chat.
describe('a local chat launch waiting on its host', () => {
  it('defers the watcher shell for a live host launch, then permits a later ordinary mount', async () => {
    mocks.gate.mockResolvedValueOnce('blocked').mockResolvedValueOnce('empty')
    root = createRoot(document.createElement('div'))
    await act(async () => root?.render(createElement(Watcher)))
    expectNoShell()

    await act(async () => root?.unmount())
    root = createRoot(document.createElement('div'))
    await act(async () => root?.render(createElement(Watcher)))
    await expectShellCreatedOnce()
  })

  it('keeps a watched create free of a stray shell until its chat opens', async () => {
    const { finish } = gateAnsweredLater()
    const launch = launchChat({
      plan: localChatPlan(),
      hooks: {},
      beforeOpen: () => true
    })
    expect(isEmptyWorkspaceDefaultSurfacePending('wt-1')).toBe(true)

    root = createRoot(document.createElement('div'))
    await act(async () => root?.render(createElement(Watcher)))
    await act(async () => finish())
    expectNoShell()

    await act(async () => mocks.answers[0]?.({ supported: true }))
    await expectChatOpenedOnce()
    expectNoShell()
    await finishChat(launch)
  })

  it("keeps an empty workspace's default chat free of a shell seeded by the shared gate", async () => {
    const { gate, finish } = gateAnsweredLater()
    const pendingLaunch = gate.then(() => launchChat({ plan: localChatPlan(), hooks: {} }))
    root = createRoot(document.createElement('div'))
    await act(async () => root?.render(createElement(Watcher)))
    await act(async () => finish())
    expect(mocks.begin).not.toHaveBeenCalled()
    expectNoShell()

    await act(async () => mocks.answers[0]?.({ supported: true }))
    await expectChatOpenedOnce()
    expectNoShell()
    await finishChat(await pendingLaunch)
  })

  it('stops owning the surface once the host has answered and its surface opened', async () => {
    const onHostDeclined = vi.fn(() => ({ opened: true }))
    const launch = launchChat({
      plan: localChatPlan(),
      hooks: {},
      onHostDeclined
    })
    expect(isEmptyWorkspaceDefaultSurfacePending('wt-1')).toBe(true)

    await act(async () => mocks.answers[0]?.({ supported: false }))
    await expect(launch?.settlement).resolves.toEqual({ kind: 'terminal' })
    expect(onHostDeclined).toHaveBeenCalledOnce()
    expect(isEmptyWorkspaceDefaultSurfacePending('wt-1')).toBe(false)
  })
})
