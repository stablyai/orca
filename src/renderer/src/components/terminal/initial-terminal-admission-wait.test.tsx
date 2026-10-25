// @vitest-environment happy-dom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const answers: ((support: unknown) => void)[] = []
  return {
    gate: vi.fn(),
    createTab: vi.fn(),
    createUnifiedTab: vi.fn(),
    begin: vi.fn(),
    select: (selector: (state: { pendingWorktreeCreations: Record<string, never> }) => unknown) =>
      selector({ pendingWorktreeCreations: {} }),
    answers
  }
})

vi.mock('@/store', () => ({
  useAppStore: Object.assign(mocks.select, {
    getState: () => ({
      activeWorktreeId: 'wt-1',
      tabsByWorktree: {},
      closedTerminalTabTombstonesByTabId: {},
      unifiedTabsByWorktree: {},
      groupsByWorktree: {},
      layoutByWorktree: {},
      activeGroupIdByWorktree: {},
      // A switch-on chat open places the tab in the workspace's root group.
      ensureWorktreeRootGroup: () => 'group-1',
      createUnifiedTab: mocks.createUnifiedTab,
      readLocalAgentInventory: () => ({ ids: null, state: 'pending' }),
      setActiveTabType: vi.fn()
    })
  })
}))
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
      ? new Promise((resolve) => mocks.answers.push(resolve))
      : new Promise(() => undefined)
}))

// Main answers the window's chat-tab open (switch-on builds).
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

import { useTerminalWatcherEffects } from '../use-terminal-watcher-effects'
import { beginStructuredAgentSessionProvisionalLaunch } from '@/lib/agent-session/structured-agent-session-provisional-tab'
import { isEmptyWorkspaceDefaultSurfacePending } from '@/lib/empty-workspace-default-surface-claims'
import type { AgentSessionLaunchPlan } from '@/lib/agent-session-launch-plan'
import type { Tab } from '../../../../shared/tab-types'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../../shared/layout-owner-switch'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root | undefined

afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  mocks.answers.length = 0
  vi.clearAllMocks()
  layoutApplyTestTransport.reset()
})

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

/** The chat opened: drawn here, or (switch-on) its open sent to main, whose frame draws it. */
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
  mocks.begin.mockReturnValue({
    sessionId: 'claude_1',
    executionHostId: 'local',
    settlement: new Promise(() => undefined),
    cancel: vi.fn()
  })
  mocks.createUnifiedTab.mockImplementation(
    (worktreeId: string, _type: string, tab: Partial<Tab>) => ({
      ...tab,
      worktreeId
    })
  )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: begin() is the only member this path calls.
  return {
    route: 'structured-native-chat',
    requestId: 'request-1',
    agent: 'claude',
    worktreeId: 'wt-1',
    executionHostId: 'local',
    begin: mocks.begin,
    launch: vi.fn()
  } as unknown as AgentSessionLaunchPlan
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
    beginStructuredAgentSessionProvisionalLaunch({
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
  })

  it("keeps an empty workspace's default chat free of a shell seeded by the shared gate", async () => {
    const { gate, finish } = gateAnsweredLater()
    void gate.then(() =>
      beginStructuredAgentSessionProvisionalLaunch({ plan: localChatPlan(), hooks: {} })
    )
    root = createRoot(document.createElement('div'))
    await act(async () => root?.render(createElement(Watcher)))
    await act(async () => finish())
    expect(mocks.begin).not.toHaveBeenCalled()
    expectNoShell()

    await act(async () => mocks.answers[0]?.({ supported: true }))
    await expectChatOpenedOnce()
    expectNoShell()
  })

  it('stops owning the surface once the host has answered and its surface opened', async () => {
    const onHostDeclined = vi.fn(() => ({ opened: true }))
    const launch = beginStructuredAgentSessionProvisionalLaunch({
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
