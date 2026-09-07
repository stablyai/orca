// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useTerminalWatcherEffects } from '../use-terminal-watcher-effects'
import type { TerminalColdActivationController } from '../terminal-cold-activation'

const mocks = vi.hoisted(() => ({
  gate: vi.fn(),
  launchStatus: vi.fn((_worktreeId: string, _provider: string): string => 'idle'),
  createTab: vi.fn()
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(() => 'none', {
    getState: () => ({ activeWorktreeId: 'wt-1' })
  })
}))
vi.mock('@/lib/worktree-agent-activation-gate', () => ({
  gateWorktreeAgentActivation: mocks.gate
}))
vi.mock('@/lib/structured-agent-session-launch', () => ({
  getStructuredAgentLaunchStatus: mocks.launchStatus
}))
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

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
let root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  vi.clearAllMocks()
})

function Watcher(): null {
  useTerminalWatcherEffects({
    activeWorktreeId: 'wt-1',
    workspaceSessionReady: true,
    terminalStartupRestorationReady: true,
    workspaceSurfaceIds: [],
    tabsByWorktree: {},
    createTab: mocks.createTab,
    reconcileWorktreeTabModel: () => ({ renderableTabCount: 0 })
  } as unknown as TerminalColdActivationController)
  return null
}

describe('passive terminal seeding during native chat creation', () => {
  it.each([
    ['claude', 'pending', 0],
    ['codex', 'pending', 0],
    ['claude', 'unknown', 0],
    ['codex', 'unknown', 0],
    ['claude', 'idle', 1]
  ] as const)('handles %s launch status %s', async (agent, status, expectedTabs) => {
    let finishGate!: (outcome: 'empty') => void
    mocks.gate.mockReturnValue(
      new Promise((resolve) => {
        finishGate = resolve
      })
    )
    mocks.launchStatus.mockReturnValue('idle')
    root = createRoot(document.createElement('div'))
    await act(async () => root?.render(<Watcher />))

    // A create starts after the inventory probe but before its empty result returns.
    mocks.launchStatus.mockImplementation((_worktreeId, provider) =>
      provider === agent ? status : 'idle'
    )
    await act(async () => finishGate('empty'))

    expect(mocks.createTab).toHaveBeenCalledTimes(expectedTabs)
  })
})
