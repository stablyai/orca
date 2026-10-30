import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { parseWorkspaceSession } from '../../../../shared/workspace-session-schema'
import {
  _resetTerminalPaneRecoveryForTests,
  requestTerminalPaneRecovery
} from './terminal-pane-recovery'

/** Reject recovery while native chat owns the surface (#19745). Read both terminal and unified indices: older disk schemas retain viewMode only in the unified row, while live index drift can leave only the terminal row. */
type StoredTerminalTab = Pick<TerminalTab, 'id' | 'viewMode'>

const WORKTREE_ID = 'repo1::/path/wt1'

const mocks = vi.hoisted(() => ({
  tabsByWorktree: {} as Record<string, unknown[]>,
  remountTerminalTabForRecovery: vi.fn(() => ({ remounted: true as const, generation: 1 })),
  getTab: vi.fn<() => { viewMode?: 'terminal' | 'chat' } | null>(() => ({})),
  hasPty: vi.fn<(id: string) => Promise<boolean | null>>(async () => true)
}))

function setTerminalTabs(tabs: StoredTerminalTab[]): void {
  mocks.tabsByWorktree = { [WORKTREE_ID]: tabs }
}

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      tabsByWorktree: mocks.tabsByWorktree,
      remountTerminalTabForRecovery: mocks.remountTerminalTabForRecovery,
      getTab: mocks.getTab
    })
  }
}))

vi.mock('@/lib/crash-breadcrumb-recorder', () => ({
  recordRendererCrashBreadcrumb: vi.fn()
}))

beforeEach(() => {
  _resetTerminalPaneRecoveryForTests()
  mocks.remountTerminalTabForRecovery.mockClear()
  mocks.getTab.mockClear()
  mocks.getTab.mockReturnValue({})
  mocks.hasPty.mockClear()
  mocks.hasPty.mockResolvedValue(true)
  setTerminalTabs([{ id: 'tab-1' }])
  vi.stubGlobal('window', { api: { pty: { hasPty: mocks.hasPty } } })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('terminal surface ownership', () => {
  it('does not remount a terminal surface hidden behind native chat', async () => {
    setTerminalTabs([{ id: 'tab-1', viewMode: 'chat' }])

    await expect(
      requestTerminalPaneRecovery({
        tabId: 'tab-1',
        ptyId: 'pty-1',
        reason: 'input-undeliverable'
      })
    ).resolves.toBe(false)
    expect(mocks.remountTerminalTabForRecovery).not.toHaveBeenCalled()
    expect(mocks.hasPty).not.toHaveBeenCalled()
  })

  it('does not remount a chat-owned tab the unified tab index has dropped', async () => {
    // Model terminal/unified index drift from b5cfc6ca; the surviving terminal row must still refuse chat recovery.
    mocks.getTab.mockReturnValue(null)
    setTerminalTabs([{ id: 'tab-1', viewMode: 'chat' }])

    await expect(
      requestTerminalPaneRecovery({
        tabId: 'tab-1',
        ptyId: 'pty-1',
        reason: 'input-undeliverable'
      })
    ).resolves.toBe(false)
    expect(mocks.remountTerminalTabForRecovery).not.toHaveBeenCalled()
    expect(mocks.hasPty).not.toHaveBeenCalled()
  })

  it('refuses a chat-owned tab whose row lost viewMode across a restart', async () => {
    // Legacy schema strips terminal-row viewMode, leaving only the unified chat ownership to refuse remount after upgrade.
    mocks.getTab.mockReturnValue({ viewMode: 'chat' })
    setTerminalTabs([{ id: 'tab-1' }])

    await expect(
      requestTerminalPaneRecovery({
        tabId: 'tab-1',
        ptyId: 'pty-1',
        reason: 'write-stalled'
      })
    ).resolves.toBe(false)
    expect(mocks.remountTerminalTabForRecovery).not.toHaveBeenCalled()
  })

  it('refuses a chat-owned row the unified tab index has no opinion on', async () => {
    // The other direction: the row is authoritative even when getTab is blind.
    mocks.getTab.mockReturnValue(null)
    setTerminalTabs([{ id: 'tab-1', viewMode: 'chat' }])

    await expect(
      requestTerminalPaneRecovery({
        tabId: 'tab-1',
        ptyId: 'pty-1',
        reason: 'write-stalled'
      })
    ).resolves.toBe(false)
    expect(mocks.remountTerminalTabForRecovery).not.toHaveBeenCalled()
  })

  it('heals a terminal-owned tab both indices agree on', async () => {
    mocks.getTab.mockReturnValue({ viewMode: 'terminal' })
    setTerminalTabs([{ id: 'tab-1', viewMode: 'terminal' }])

    await expect(
      requestTerminalPaneRecovery({
        tabId: 'tab-1',
        ptyId: 'pty-1',
        reason: 'write-stalled'
      })
    ).resolves.toBe(true)
  })

  // Use the real old-session loader: undeclared terminal-row viewMode strips while unified chat ownership survives, requiring both guard arms.
  it('refuses a chat-owned tab an older build persisted without a row viewMode', async () => {
    const loaded = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: WORKTREE_ID,
      activeTabId: 'tab-1',
      tabsByWorktree: {
        // Exactly what a pre-viewMode build wrote for the terminal row.
        [WORKTREE_ID]: [
          {
            id: 'tab-1',
            ptyId: null,
            worktreeId: WORKTREE_ID,
            title: 'Terminal 1',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 0
          }
        ]
      },
      unifiedTabs: {
        [WORKTREE_ID]: [
          {
            id: 'tab-1',
            entityId: 'terminal-1',
            groupId: 'group-1',
            worktreeId: WORKTREE_ID,
            contentType: 'terminal',
            label: 'Terminal 1',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 0,
            viewMode: 'chat'
          }
        ]
      },
      terminalLayoutsByTabId: {}
    })
    expect(loaded.ok).toBe(true)
    const session = loaded.ok ? loaded.value : null
    const reloadedRow = session?.tabsByWorktree[WORKTREE_ID]?.[0]
    const reloadedUnifiedTab = session?.unifiedTabs?.[WORKTREE_ID]?.[0]
    // The premise: the load boundary really did drop the row's ownership.
    expect(reloadedRow?.viewMode).toBeUndefined()
    expect(reloadedUnifiedTab?.viewMode).toBe('chat')

    setTerminalTabs([reloadedRow as StoredTerminalTab])
    mocks.getTab.mockReturnValue(reloadedUnifiedTab as { viewMode?: 'terminal' | 'chat' })

    await expect(
      requestTerminalPaneRecovery({
        tabId: 'tab-1',
        ptyId: 'pty-1',
        reason: 'write-stalled'
      })
    ).resolves.toBe(false)
    expect(mocks.remountTerminalTabForRecovery).not.toHaveBeenCalled()
  })

  // Round-trip through disk/Zod: undeclared fields vanish only at load, invisible to same-process assertions.
  it('still refuses a chat-owned tab after a real persist/parse round trip', async () => {
    const loaded = parseWorkspaceSession({
      activeRepoId: null,
      activeWorktreeId: WORKTREE_ID,
      activeTabId: 'tab-1',
      tabsByWorktree: {
        [WORKTREE_ID]: [
          {
            id: 'tab-1',
            ptyId: null,
            worktreeId: WORKTREE_ID,
            title: 'Terminal 1',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 0,
            viewMode: 'chat'
          }
        ]
      },
      terminalLayoutsByTabId: {}
    })
    expect(loaded.ok).toBe(true)
    setTerminalTabs(
      (loaded.ok ? loaded.value.tabsByWorktree[WORKTREE_ID] : []) as StoredTerminalTab[]
    )
    // Blind on purpose: only the reloaded row can refuse this.
    mocks.getTab.mockReturnValue(null)

    await expect(
      requestTerminalPaneRecovery({
        tabId: 'tab-1',
        ptyId: 'pty-1',
        reason: 'write-stalled'
      })
    ).resolves.toBe(false)
    expect(mocks.remountTerminalTabForRecovery).not.toHaveBeenCalled()
  })
})
