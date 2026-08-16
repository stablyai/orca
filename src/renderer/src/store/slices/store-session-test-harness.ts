import { vi, type Mock } from 'vitest'
import type { BrowserTab } from '../../../../shared/browser-workspace-types'

/** Shape shared by the Claude/Codex/OpenCode usage-scanner namespaces. */
type UsageScannerMocks = {
  getScanState: Mock
  setEnabled: Mock
  refresh: Mock
  getSummary: Mock
  getDaily: Mock
  getBreakdown: Mock
  getRecentSessions: Mock
}

export type StoreSessionMockApi = {
  worktrees: { list: Mock; create: Mock; remove: Mock; updateMeta: Mock }
  repos: { list: Mock; add: Mock; remove: Mock; update: Mock; pickFolder: Mock }
  pty: { kill: Mock }
  gh: { prForBranch: Mock; issue: Mock }
  settings: { get: Mock; set: Mock }
  cache: { getGitHub: Mock; setGitHub: Mock }
  claudeUsage: UsageScannerMocks
  codexUsage: UsageScannerMocks
  openCodeUsage: UsageScannerMocks
}

/** window.api double shared by the store session suites; installs itself on globalThis. */
export function createStoreSessionMockApi(): StoreSessionMockApi {
  const mockApi: StoreSessionMockApi = {
    worktrees: {
      list: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({}),
      remove: vi.fn().mockResolvedValue(undefined),
      updateMeta: vi.fn().mockResolvedValue({})
    },
    repos: {
      list: vi.fn().mockResolvedValue([]),
      add: vi.fn().mockResolvedValue({}),
      remove: vi.fn().mockResolvedValue(undefined),
      update: vi.fn().mockResolvedValue({}),
      pickFolder: vi.fn().mockResolvedValue(null)
    },
    pty: {
      kill: vi.fn().mockResolvedValue(undefined)
    },
    gh: {
      prForBranch: vi.fn().mockResolvedValue(null),
      issue: vi.fn().mockResolvedValue(null)
    },
    settings: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined)
    },
    cache: {
      getGitHub: vi.fn().mockResolvedValue(null),
      setGitHub: vi.fn().mockResolvedValue(undefined)
    },
    claudeUsage: {
      getScanState: vi.fn().mockResolvedValue({
        enabled: false,
        isScanning: false,
        lastScanStartedAt: null,
        lastScanCompletedAt: null,
        lastScanError: null,
        hasAnyClaudeData: false
      }),
      setEnabled: vi.fn().mockResolvedValue({}),
      refresh: vi.fn().mockResolvedValue({}),
      getSummary: vi.fn().mockResolvedValue(null),
      getDaily: vi.fn().mockResolvedValue([]),
      getBreakdown: vi.fn().mockResolvedValue([]),
      getRecentSessions: vi.fn().mockResolvedValue([])
    },
    codexUsage: {
      getScanState: vi.fn().mockResolvedValue({
        enabled: false,
        isScanning: false,
        lastScanStartedAt: null,
        lastScanCompletedAt: null,
        lastScanError: null,
        hasAnyCodexData: false
      }),
      setEnabled: vi.fn().mockResolvedValue({}),
      refresh: vi.fn().mockResolvedValue({}),
      getSummary: vi.fn().mockResolvedValue(null),
      getDaily: vi.fn().mockResolvedValue([]),
      getBreakdown: vi.fn().mockResolvedValue([]),
      getRecentSessions: vi.fn().mockResolvedValue([])
    },
    openCodeUsage: {
      getScanState: vi.fn().mockResolvedValue({
        enabled: false,
        isScanning: false,
        lastScanStartedAt: null,
        lastScanCompletedAt: null,
        lastScanError: null,
        hasAnyOpenCodeData: false
      }),
      setEnabled: vi.fn().mockResolvedValue({}),
      refresh: vi.fn().mockResolvedValue({}),
      getSummary: vi.fn().mockResolvedValue(null),
      getDaily: vi.fn().mockResolvedValue([]),
      getBreakdown: vi.fn().mockResolvedValue([]),
      getRecentSessions: vi.fn().mockResolvedValue([])
    }
  }

  // @ts-expect-error -- mock
  globalThis.window = { api: mockApi }
  return mockApi
}

export function makeBrowserTab(
  overrides: Partial<BrowserTab> & { id: string; worktreeId: string; url: string }
): BrowserTab {
  return {
    title: overrides.url,
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: Date.now(),
    ...overrides
  }
}
