import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { parseWorkspaceSession } from '../../../../shared/workspace-session-schema'
import {
  _resetTerminalPaneRecoveryForTests,
  requestTerminalPaneRecovery
} from './terminal-pane-recovery'

/**
 * Who owns the rendered surface, and therefore whether recovery may remount it.
 *
 * A terminal-backed tab is intentionally hidden while native chat owns the
 * provider. Late xterm callbacks from that hidden surface must not remount the
 * tab and race the handoff's owner transition (#19745).
 *
 * The guard reads BOTH indices on purpose. The terminal row is the durable
 * record — viewMode persists on it, and the local toggles patch it in the same
 * set() as the unified tab — but a session written before the row carried
 * viewMode loads with it only on the unified tab. More generally this is a
 * disjunction over two partly-redundant sources for a safety check: a hole in
 * either index errs toward declining a heal, never toward remounting a
 * chat-owned surface.
 */
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
    // The drift crash b5cfc6ca documents: present in tabsByWorktree, gone from
    // unifiedTabsByWorktree. getTab answers null, and the guard reads the row.
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
    // The upgrade transition: a session written before viewMode was declared on
    // terminalTabSchema has it only on the unified tab, so the row loads
    // undefined. Reading the row alone remounted a chat-owned hidden surface on
    // the first launch after upgrade — the race the guard exists to stop.
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

  // The upgrade population, driven through the real loader rather than a stub:
  // a session an OLDER build wrote carries viewMode only on the unified tab,
  // because terminalTabSchema did not declare it yet. Zod strips what it does
  // not declare, so the reloaded ROW reads undefined while the reloaded UNIFIED
  // TAB still says 'chat'. Only the second arm of the guard's disjunction can
  // refuse this one — which is why the arm #19745 added was kept.
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

  // The case a same-process test cannot reach: the row goes to disk and comes
  // back through the real Zod loader. A field the schema does not declare is
  // stripped there, silently, and every in-session assertion still passes.
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
