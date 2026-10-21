import { afterEach, vi } from 'vitest'
import type { Mock } from 'vitest'
import { getDefaultSettings } from '../../../shared/constants'
import { resetHookCommandDelayedDeliveryForTests } from './hook-command-delayed-delivery'
import { useAppStore } from '@/store'

export type AppStoreState = ReturnType<typeof useAppStore.getState>

const initialTabsByWorktree = useAppStore.getState().tabsByWorktree
const initialWorktreesByRepo = useAppStore.getState().worktreesByRepo
const initialGetKnownWorktreeById = useAppStore.getState().getKnownWorktreeById
const initialPendingIssueCommandSplitByTabId =
  useAppStore.getState().pendingIssueCommandSplitByTabId

export function setLegacySetupScriptLaunchMode(
  mode: 'split-vertical' | 'split-horizontal' | 'new-tab' | null
): void {
  useAppStore.setState((state) => ({
    settings: { ...(state.settings ?? getDefaultSettings('')), setupScriptLaunchMode: mode }
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
    setLegacySetupScriptLaunchMode(null)
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
  createTab: Mock<(...args: unknown[]) => { id: string }>
  setActiveTab: Mock<() => void>
  setTabCustomTitle: Mock<() => void>
  setTabColor: Mock<() => void>
  markDefaultTerminalTabsApplied: Mock<() => void>
  reconcileWorktreeTabModel: Mock<() => { renderableTabCount: number }>
  queueTabInitialCwd: Mock<() => void>
  queueTabIssueCommandSplit: Mock<() => void>
}

export function createMockStore(overrides: Record<string, unknown> = {}): MockActivationStore {
  let created = 0
  return {
    tabsByWorktree: {} as Record<string, { id: string }[]>,
    defaultTerminalTabsAppliedByWorktreeId: {} as Record<string, true>,
    createTab: vi.fn(() => ({ id: `tab-${++created}` })),
    setActiveTab: vi.fn(),
    setTabCustomTitle: vi.fn(),
    setTabColor: vi.fn(),
    markDefaultTerminalTabsApplied: vi.fn(),
    reconcileWorktreeTabModel: vi.fn(() => ({ renderableTabCount: 0 })),
    queueTabInitialCwd: vi.fn(),
    queueTabIssueCommandSplit: vi.fn(),
    ...overrides
  }
}

/** The startup command each created tab was published with, keyed by the created tab's id. */
export function createdTabStartups(store: MockActivationStore): Record<string, unknown> {
  const startups: Record<string, unknown> = {}
  store.createTab.mock.calls.forEach((call, index) => {
    const result = store.createTab.mock.results[index]
    const options = call[3]
    if (
      result?.type === 'return' &&
      options &&
      typeof options === 'object' &&
      'pendingStartup' in options
    ) {
      startups[result.value.id] = options.pendingStartup
    }
  })
  return startups
}
