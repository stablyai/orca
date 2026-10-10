import { afterEach, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { SetupScriptLaunchMode } from '../../../shared/worktree/launch-types'
import { resetHookCommandDelayedDeliveryForTests } from './hook-command-delayed-delivery'
import { useAppStore } from '@/store'

export type AppStoreState = ReturnType<typeof useAppStore.getState>

const initialTabsByWorktree = useAppStore.getState().tabsByWorktree
const initialWorktreesByRepo = useAppStore.getState().worktreesByRepo
const initialGetKnownWorktreeById = useAppStore.getState().getKnownWorktreeById
const initialPendingIssueCommandSplitByTabId =
  useAppStore.getState().pendingIssueCommandSplitByTabId

export function setSetupScriptLaunchMode(mode: SetupScriptLaunchMode | null): void {
  useAppStore.setState((state) => ({
    settings: state.settings
      ? { ...state.settings, setupScriptLaunchMode: mode ?? 'new-tab' }
      : mode !== null
        ? ({ setupScriptLaunchMode: mode } as unknown as typeof state.settings)
        : state.settings
  }))
}

/** Restores the module-level store slices these activation suites mutate. */
export function registerWorktreeActivationReset(): void {
  afterEach(() => {
    delete (globalThis as { __ORCA_WEB_CLIENT__?: boolean }).__ORCA_WEB_CLIENT__
    useAppStore.setState((state) => ({
      settings: state.settings
        ? { ...state.settings, activeRuntimeEnvironmentId: null }
        : ({ activeRuntimeEnvironmentId: null } as unknown as typeof state.settings)
    }))
    setSetupScriptLaunchMode('new-tab')
    resetHookCommandDelayedDeliveryForTests()
    useAppStore.setState({
      tabsByWorktree: initialTabsByWorktree,
      worktreesByRepo: initialWorktreesByRepo,
      getKnownWorktreeById: initialGetKnownWorktreeById,
      pendingIssueCommandSplitByTabId: initialPendingIssueCommandSplitByTabId
    } as Partial<AppStoreState>)
  })
}

/** Store surface the activation entry points touch, with every action spied. */
export type MockActivationStore = {
  tabsByWorktree: Record<string, { id: string }[]>
  defaultTerminalTabsAppliedByWorktreeId: Record<string, true>
  createTab: Mock<() => { id: string }>
  setActiveTab: Mock<() => void>
  setTabCustomTitle: Mock<() => void>
  setTabColor: Mock<() => void>
  markDefaultTerminalTabsApplied: Mock<() => void>
  reconcileWorktreeTabModel: Mock<() => { renderableTabCount: number }>
  queueTabStartupCommand: Mock<() => void>
  queueTabInitialCwd: Mock<() => void>
  queueTabSetupSplit: Mock<() => void>
  queueTabIssueCommandSplit: Mock<() => void>
}

export function createMockStore(overrides: Record<string, unknown> = {}): MockActivationStore {
  return {
    tabsByWorktree: {} as Record<string, { id: string }[]>,
    defaultTerminalTabsAppliedByWorktreeId: {} as Record<string, true>,
    createTab: vi.fn(() => ({ id: 'tab-1' })),
    setActiveTab: vi.fn(),
    setTabCustomTitle: vi.fn(),
    setTabColor: vi.fn(),
    markDefaultTerminalTabsApplied: vi.fn(),
    reconcileWorktreeTabModel: vi.fn(() => ({ renderableTabCount: 0 })),
    queueTabStartupCommand: vi.fn(),
    queueTabInitialCwd: vi.fn(),
    queueTabSetupSplit: vi.fn(),
    queueTabIssueCommandSplit: vi.fn(),
    ...overrides
  }
}
