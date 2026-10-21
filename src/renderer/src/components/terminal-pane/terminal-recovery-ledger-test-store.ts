import { vi, type Mock } from 'vitest'
import {
  createRemountTerminalTabForRecovery,
  createSettleTerminalTabRecovery
} from '@/store/slices/worktrees/session/worktree-slice-lookups'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'

// Why a shared fake store: the recovery budget is a field on the tab row, so a
// fake that only answered booleans cannot express what these modules read. The
// store actions below are the REAL ones, driven over a minimal state bag —
// every suite that exercises the ledger needs exactly that, and a second copy
// would be free to drift from the shape the store actually writes.
//
// Deliberately imports nothing from terminal-pane-recovery: the `@/store` mock
// factory imports THIS module, so a back-edge to the module under test would
// deadlock the factory. The request/settle cycle lives in the sibling driver.

export type StoredTerminalTab = Pick<TerminalTab, 'id' | 'viewMode' | 'generation' | 'recovery'>

export const WORKTREE_ID = 'repo1::/path/wt1'

/** Explicit, because an inferred `vi.fn()` shape is not portable across projects. */
type RecoveryLedgerMocks = {
  state: {
    tabsByWorktree: Record<string, unknown[]>
    terminalLayoutsByTabId: Record<string, unknown>
    pendingStartupByTabId: Record<string, unknown>
  }
  remountTerminalTabForRecovery: Mock<(tabId: string) => void>
  getTab: Mock<() => { viewMode?: 'terminal' | 'chat' } | null>
  recordRendererCrashBreadcrumb: Mock<(...args: unknown[]) => void>
  hasPty: Mock<(id: string) => Promise<boolean | null>>
}

export const recoveryLedgerMocks: RecoveryLedgerMocks = {
  state: {
    tabsByWorktree: {} as Record<string, unknown[]>,
    terminalLayoutsByTabId: {} as Record<string, unknown>,
    pendingStartupByTabId: {} as Record<string, unknown>
  },
  // Records tabIds the store ACTUALLY remounted, so every assertion keeps
  // meaning "a remount happened" rather than "a remount was asked for".
  remountTerminalTabForRecovery: vi.fn<(tabId: string) => void>(),
  getTab: vi.fn<() => { viewMode?: 'terminal' | 'chat' } | null>(() => ({})),
  recordRendererCrashBreadcrumb: vi.fn(),
  hasPty: vi.fn<(id: string) => Promise<boolean | null>>(async () => true)
}

const storeSet = (updater: unknown): void => {
  const patch =
    typeof updater === 'function'
      ? (updater as (state: unknown) => object)(recoveryLedgerMocks.state)
      : (updater as object)
  Object.assign(recoveryLedgerMocks.state, patch)
}
const storeGet = (): unknown => recoveryLedgerMocks.state

const realRemount = createRemountTerminalTabForRecovery(storeSet as never, storeGet as never)
const realSettle = createSettleTerminalTabRecovery(storeSet as never, storeGet as never)

const recordingRemount: typeof realRemount = (tabId, request) => {
  const result = realRemount(tabId, request)
  if (result.remounted) {
    recoveryLedgerMocks.remountTerminalTabForRecovery(tabId)
  }
  return result
}

/** The `@/store` surface these suites mock, wired to the real store actions. */
export function recoveryLedgerStoreState(): Record<string, unknown> {
  return {
    ...recoveryLedgerMocks.state,
    remountTerminalTabForRecovery: recordingRemount,
    settleTerminalTabRecovery: realSettle,
    getTab: recoveryLedgerMocks.getTab
  }
}

export function terminalTabs(): StoredTerminalTab[] {
  return (recoveryLedgerMocks.state.tabsByWorktree[WORKTREE_ID] ?? []) as StoredTerminalTab[]
}

export function setTerminalTabs(tabs: StoredTerminalTab[]): void {
  recoveryLedgerMocks.state.tabsByWorktree = { [WORKTREE_ID]: tabs }
}

export function resetRecoveryLedgerStore(): void {
  recoveryLedgerMocks.remountTerminalTabForRecovery.mockReset()
  recoveryLedgerMocks.getTab.mockClear()
  recoveryLedgerMocks.getTab.mockReturnValue({})
  recoveryLedgerMocks.state.terminalLayoutsByTabId = {}
  recoveryLedgerMocks.state.pendingStartupByTabId = {}
  recoveryLedgerMocks.recordRendererCrashBreadcrumb.mockClear()
  recoveryLedgerMocks.hasPty.mockClear()
  recoveryLedgerMocks.hasPty.mockResolvedValue(true)
}
