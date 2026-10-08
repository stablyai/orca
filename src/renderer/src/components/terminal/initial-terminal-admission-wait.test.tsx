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
    answers
  }
})

vi.mock('@/store', () => ({
  useAppStore: Object.assign(() => 'none', {
    getState: () => ({
      activeWorktreeId: 'wt-1',
      tabsByWorktree: {},
      closedTerminalTabTombstonesByTabId: {},
      unifiedTabsByWorktree: {},
      activeGroupIdByWorktree: {},
      createUnifiedTab: mocks.createUnifiedTab,
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

import { useTerminalWatcherEffects } from '../use-terminal-watcher-effects'
import { beginStructuredAgentSessionProvisionalLaunch } from '@/lib/structured-agent-session-provisional-tab'
import { isEmptyWorkspaceDefaultSurfacePending } from '@/lib/empty-workspace-default-surface-claims'
import type { AgentSessionLaunchPlan } from '@/lib/agent-session-launch-plan'
import type { Tab } from '../../../../shared/tab-types'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
let root: Root | undefined

afterEach(async () => {
  await act(async () => root?.unmount())
  root = undefined
  mocks.answers.length = 0
  vi.clearAllMocks()
})

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

// While this machine decides, a passive first-terminal seeder used to put "Terminal 1" beside the
// chat, since no launch record exists until the host answers.
describe('a local chat launch waiting on its host', () => {
  it('keeps a watched create free of a stray shell until its chat opens', async () => {
    const { finish } = gateAnsweredLater()
    // A watched create reveals the workspace, then waits for this machine's answer.
    beginStructuredAgentSessionProvisionalLaunch({
      plan: localChatPlan(),
      hooks: {},
      beforeOpen: () => true
    })
    expect(isEmptyWorkspaceDefaultSurfacePending('wt-1')).toBe(true)

    root = createRoot(document.createElement('div'))
    await act(async () => root?.render(createElement(Watcher)))
    await act(async () => finish())
    expect(mocks.createTab).not.toHaveBeenCalled()

    await act(async () => mocks.answers[0]?.({ supported: true }))
    expect(mocks.createUnifiedTab).toHaveBeenCalledOnce()
    expect(mocks.createTab).not.toHaveBeenCalled()
  })

  it("keeps an empty workspace's default chat free of a shell seeded by the shared gate", async () => {
    const { gate, finish } = gateAnsweredLater()
    // The activation's reseed attaches first and opens the default agent as a chat.
    void gate.then(() =>
      beginStructuredAgentSessionProvisionalLaunch({ plan: localChatPlan(), hooks: {} })
    )
    root = createRoot(document.createElement('div'))
    // The watcher shares that in-flight gate and runs right after the reseed.
    await act(async () => root?.render(createElement(Watcher)))
    await act(async () => finish())
    expect(mocks.begin).not.toHaveBeenCalled()
    expect(mocks.createTab).not.toHaveBeenCalled()

    await act(async () => mocks.answers[0]?.({ supported: true }))
    expect(mocks.createUnifiedTab).toHaveBeenCalledOnce()
    expect(mocks.createTab).not.toHaveBeenCalled()
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
