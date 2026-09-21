import { createBrowserUuid } from '@/lib/browser-uuid'
import type { TerminalSlice, TerminalStoreGet, TerminalStoreSet } from './terminal-state'

export function createTerminalStartupQueueActions(
  set: TerminalStoreSet,
  get: TerminalStoreGet
): Pick<
  TerminalSlice,
  | 'queueTabStartupCommand'
  | 'queueTabInitialCwd'
  | 'consumeTabInitialCwd'
  | 'consumeTabStartupCommand'
  | 'queueTabSetupSplit'
  | 'consumeTabSetupSplit'
  | 'queueTabIssueCommandSplit'
  | 'consumeTabIssueCommandSplit'
  | 'consumePendingSnapshot'
  | 'consumePendingColdRestore'
> {
  return {
    queueTabStartupCommand: (tabId, startup) => {
      // Why: launchToken is only meaningful for tracked launch-config reuse; plain startup commands must not mint a synthetic token.
      const launchToken = startup.launchConfig
        ? (startup.launchToken ?? createBrowserUuid())
        : undefined
      set((s) => ({
        pendingStartupByTabId: {
          ...s.pendingStartupByTabId,
          [tabId]: {
            ...startup,
            ...(launchToken ? { launchToken } : {})
          }
        }
      }))
    },
    queueTabInitialCwd: (tabId, cwd) => {
      set((s) => ({
        pendingInitialCwdByTabId: {
          ...s.pendingInitialCwdByTabId,
          [tabId]: cwd
        }
      }))
    },
    consumeTabInitialCwd: (tabId) => {
      const pending = get().pendingInitialCwdByTabId[tabId]
      if (!pending) {
        return null
      }
      set((s) => {
        const next = { ...s.pendingInitialCwdByTabId }
        delete next[tabId]
        return { pendingInitialCwdByTabId: next }
      })
      return pending
    },
    consumeTabStartupCommand: (tabId, expected) => {
      const pending = get().pendingStartupByTabId[tabId]
      // Why identity, not equality: the one-shot settle must only spend the exact captured
      // startup; a newer queued command for the same tab is someone else's to consume.
      if (!pending || (expected && pending !== expected)) {
        return null
      }
      set((s) => {
        if (s.pendingStartupByTabId[tabId] !== pending) {
          return {}
        }
        const next = { ...s.pendingStartupByTabId }
        delete next[tabId]
        return { pendingStartupByTabId: next }
      })
      return pending
    },
    queueTabSetupSplit: (tabId, startup) => {
      set((s) => ({
        pendingSetupSplitByTabId: {
          ...s.pendingSetupSplitByTabId,
          [tabId]: startup
        }
      }))
    },
    consumeTabSetupSplit: (tabId) => {
      const pending = get().pendingSetupSplitByTabId[tabId]
      if (!pending) {
        return null
      }
      set((s) => {
        const next = { ...s.pendingSetupSplitByTabId }
        delete next[tabId]
        return { pendingSetupSplitByTabId: next }
      })
      return pending
    },
    queueTabIssueCommandSplit: (tabId, issueCommand) => {
      set((s) => ({
        pendingIssueCommandSplitByTabId: {
          ...s.pendingIssueCommandSplitByTabId,
          [tabId]: issueCommand
        }
      }))
    },
    consumeTabIssueCommandSplit: (tabId) => {
      const pending = get().pendingIssueCommandSplitByTabId[tabId]
      if (!pending) {
        return null
      }
      set((s) => {
        const next = { ...s.pendingIssueCommandSplitByTabId }
        delete next[tabId]
        return { pendingIssueCommandSplitByTabId: next }
      })
      return pending
    },
    consumePendingSnapshot: (ptyId) => {
      const snapshot = get().pendingSnapshotByPtyId[ptyId]
      if (!snapshot) {
        return null
      }
      set((s) => {
        const next = { ...s.pendingSnapshotByPtyId }
        delete next[ptyId]
        return { pendingSnapshotByPtyId: next }
      })
      return snapshot
    },
    consumePendingColdRestore: (ptyId) => {
      const data = get().pendingColdRestoreByPtyId[ptyId]
      if (!data) {
        return null
      }
      set((s) => {
        const next = { ...s.pendingColdRestoreByPtyId }
        delete next[ptyId]
        return { pendingColdRestoreByPtyId: next }
      })
      return data
    }
  }
}
