import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as TelemetryModule from '@/lib/telemetry'

const mockCreateTab = vi.fn()
const mockCreateEmptySplitGroup = vi.fn()
const mockQueueTabStartupCommand = vi.fn()
const mockSetActiveTabType = vi.fn()
const mockSetTabBarOrder = vi.fn()
const runtimeMocks = vi.hoisted(() => ({
  createWebRuntimeSessionTerminal: vi.fn(),
  getRuntimeEnvironmentIdForWorktree: vi.fn<() => string | null>(() => null),
  isWebRuntimeSessionActive: vi.fn(() => false)
}))

const tabsByWorktree: Record<string, { id: string }[]> = {}
const openFiles: { id: string; worktreeId: string }[] = []
const browserTabsByWorktree: Record<string, { id: string }[]> = {}
const tabBarOrderByWorktree: Record<string, string[]> = {}

const mockState = {
  createTab: mockCreateTab,
  createEmptySplitGroup: mockCreateEmptySplitGroup,
  closeEmptyGroup: vi.fn(),
  queueTabStartupCommand: mockQueueTabStartupCommand,
  setActiveTabType: mockSetActiveTabType,
  setTabBarOrder: mockSetTabBarOrder,
  tabsByWorktree,
  openFiles,
  browserTabsByWorktree,
  tabBarOrderByWorktree
}

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => mockState
  }
}))

vi.mock('@/components/tab-bar/reconcile-order', () => ({
  reconcileTabOrder: (
    _current: string[] | undefined,
    terminalIds: string[],
    editorIds: string[],
    browserIds: string[]
  ) => [...terminalIds, ...editorIds, ...browserIds]
}))

// Why real tuiAgentToAgentKind: the agent_kind the window stamps is part of the baseline.
vi.mock('@/lib/telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof TelemetryModule>()),
  track: vi.fn()
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: runtimeMocks.getRuntimeEnvironmentIdForWorktree
}))

vi.mock('@/runtime/web-runtime-session', () => ({
  createWebRuntimeSessionTerminal: runtimeMocks.createWebRuntimeSessionTerminal,
  isWebRuntimeSessionActive: runtimeMocks.isWebRuntimeSessionActive
}))

import { launchAiVaultSessionInNewTab } from './launch-ai-vault-session'

const AGY_ENV = { AGY_CLI_HIDE_ACCOUNT_INFO: '1' }
const LAUNCH_CONFIG = {
  agentCommand: "agy '--model' 'claude-sonnet-4-6'",
  agentArgs: '--model claude-sonnet-4-6',
  agentEnv: AGY_ENV
}
// The shape buildAiVaultResumeStartupForWorktree returns for a reference (pinned in ai-vault-antigravity-reference-startup.test.ts).
const REFERENCE_STARTUP = {
  command: "agy '--model' 'claude-sonnet-4-6' --prompt-interactive 'Review the chat transcript.'",
  env: AGY_ENV,
  launchConfig: LAUNCH_CONFIG
}

// Pins main's current launch behaviour as the convergence parity baseline (row 6): the exact local tab and queued startup an Antigravity reference launch produces.
describe('row 6: launchAiVaultSessionInNewTab for an Antigravity reference on main', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runtimeMocks.getRuntimeEnvironmentIdForWorktree.mockReturnValue(null)
    runtimeMocks.isWebRuntimeSessionActive.mockReturnValue(false)
    mockState.tabsByWorktree = {}
    mockCreateTab.mockImplementation((worktreeId: string) => {
      const tab = { id: `tab-${(mockState.tabsByWorktree[worktreeId] ?? []).length + 1}` }
      mockState.tabsByWorktree[worktreeId] = [...(mockState.tabsByWorktree[worktreeId] ?? []), tab]
      return tab
    })
  })

  it.each([
    // createTab gets only startupCwd: unlike a typed-prompt tab, there is no launchAgent option.
    {
      name: 'with a recorded cwd',
      cwd: '/home/alice/project',
      createTabCall: ['wt-1', 'group-1', undefined, { startupCwd: '/home/alice/project' }]
    },
    { name: 'without a cwd', cwd: undefined, createTabCall: ['wt-1', 'group-1'] }
  ])('$name', ({ cwd, createTabCall }) => {
    const result = launchAiVaultSessionInNewTab({
      agent: 'antigravity',
      worktreeId: 'wt-1',
      targetGroupId: 'group-1',
      ...REFERENCE_STARTUP,
      ...(cwd ? { cwd } : {})
    })

    expect(mockCreateTab.mock.calls).toStrictEqual([createTabCall])
    // main today: a fresh reference conversation is labelled request_kind 'resume'.
    expect(mockQueueTabStartupCommand.mock.calls).toStrictEqual([
      [
        'tab-1',
        {
          command: REFERENCE_STARTUP.command,
          env: AGY_ENV,
          launchConfig: LAUNCH_CONFIG,
          launchAgent: 'antigravity',
          telemetry: {
            agent_kind: 'antigravity',
            launch_source: 'sidebar',
            request_kind: 'resume'
          }
        }
      ]
    ])
    expect(mockSetActiveTabType).toHaveBeenCalledExactlyOnceWith('terminal', 'wt-1')
    expect(mockSetTabBarOrder).toHaveBeenCalledExactlyOnceWith('wt-1', ['tab-1'])
    expect(result).toStrictEqual({ tabId: 'tab-1', groupId: 'group-1' })
  })
})
