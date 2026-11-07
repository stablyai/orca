import { describe, it, expect, vi, beforeEach } from 'vitest'
import '../../workspace-attention/workspace-unread-characterization-fixture'
import type * as AgentStatusModule from '@/lib/agent-status'
import { buildWorktreeComparator } from '../../../../../../shared/sidebar-list/smart-sort'
import '../../../../../../shared/workspace-scope'
import { createTestStore, seedStore } from '../../../testing/app-store-test-fixture'
import { makeOpenFile } from '../../editor/types/open-file.test-fixture'
import { makeTab } from '../../../terminals/terminal-tab.test-fixture'
import { makeTabGroup, makeUnifiedTab } from '../../tabs/tab-group.test-fixture'
import { makeWorktree } from '../worktree.test-fixture'
import { createStoreCascadesMockApi } from '../../../testing/app-store-cascade-api.test-fixture'

const mockUnregisterPtyDataHandlers = vi.hoisted(() => vi.fn<() => unknown[]>(() => []))
const mockRestorePtyDataHandlersAfterFailedShutdown = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
}))

vi.mock('@/components/terminal-pane/pty-transport/delivery/pty-dispatcher', () => ({}))

vi.mock('@/components/terminal-pane/pty-transport/shutdown/pty-shutdown-data-suspension', () => ({
  restorePtyDataHandlersAfterFailedShutdown: mockRestorePtyDataHandlersAfterFailedShutdown,
  unregisterPtyDataHandlers: mockUnregisterPtyDataHandlers
}))

vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return {
    ...actual,
    detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
  }
})

const mockApi = createStoreCascadesMockApi()

describe('setActiveWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockApi.worktrees.updateMeta.mockResolvedValue({})
  })

  it('does not change smart-sort rank after selection when a background event bumps sortEpoch', () => {
    const store = createTestStore()
    const focusedId = 'repo1::/path/focused'
    const backgroundId = 'repo1::/path/background'
    const now = new Date('2026-04-16T12:00:00.000Z').getTime()

    vi.spyOn(Date, 'now').mockReturnValue(now)

    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: focusedId,
            repoId: 'repo1',
            displayName: 'Focused',
            lastActivityAt: now - 2 * 60_000
          }),
          makeWorktree({
            id: backgroundId,
            repoId: 'repo1',
            displayName: 'Background',
            lastActivityAt: now - 60_000
          })
        ]
      },
      refreshGitHubForWorktree: vi.fn(),
      refreshGitHubForWorktreeIfStale: vi.fn()
    })

    store.getState().setActiveWorktree(focusedId)
    store.getState().bumpWorktreeActivity(backgroundId)

    const worktrees = [...store.getState().worktreesByRepo.repo1]
    const repoMap = new Map(store.getState().repos.map((repo) => [repo.id, repo]))
    worktrees.sort(buildWorktreeComparator('smart', repoMap, now, new Map()))

    expect(worktrees.map((worktree) => worktree.id)).toEqual([backgroundId, focusedId])
  })

  it('falls back to the worktree browser tab when the restored editor id belongs to a different worktree', () => {
    const store = createTestStore()
    const wt1 = 'repo1::/path/wt1'
    const wt2 = 'repo1::/path/wt2'
    const otherFileId = '/path/wt2/file.ts'
    const browserTabId = 'browser-1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [
          makeWorktree({ id: wt1, repoId: 'repo1', path: '/path/wt1' }),
          makeWorktree({ id: wt2, repoId: 'repo1', path: '/path/wt2' })
        ]
      },
      openFiles: [makeOpenFile({ id: otherFileId, worktreeId: wt2 })],
      activeFileIdByWorktree: { [wt1]: otherFileId },
      browserTabsByWorktree: {
        [wt1]: [
          {
            id: browserTabId,
            worktreeId: wt1,
            url: 'https://example.com',
            title: 'Example',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 0
          }
        ]
      },
      activeBrowserTabIdByWorktree: { [wt1]: browserTabId },
      activeTabTypeByWorktree: { [wt1]: 'editor' }
    })

    store.getState().setActiveWorktree(wt1)

    const s = store.getState()
    expect(s.activeWorktreeId).toBe(wt1)
    expect(s.activeBrowserTabId).toBe(browserTabId)
    expect(s.activeTabType).toBe('browser')
    expect(s.activeFileId).toBeNull()
  })

  it('prefers the unified active tab over stale legacy browser restore state', () => {
    const store = createTestStore()
    const wt = 'repo1::/path/wt1'
    const groupId = 'group-1'
    const terminalId = 'terminal-1'
    const browserTabId = 'browser-1'

    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: wt, repoId: 'repo1', path: '/path/wt1' })]
      },
      tabsByWorktree: {
        [wt]: [makeTab({ id: terminalId, worktreeId: wt })]
      },
      browserTabsByWorktree: {
        [wt]: [
          {
            id: browserTabId,
            worktreeId: wt,
            url: 'https://example.com',
            title: 'Example',
            loading: false,
            faviconUrl: null,
            canGoBack: false,
            canGoForward: false,
            loadError: null,
            createdAt: 0
          }
        ]
      },
      activeBrowserTabIdByWorktree: { [wt]: browserTabId },
      activeTabTypeByWorktree: { [wt]: 'browser' },
      unifiedTabsByWorktree: {
        [wt]: [
          makeUnifiedTab({
            id: 'tab-terminal-1',
            entityId: terminalId,
            worktreeId: wt,
            groupId,
            contentType: 'terminal'
          }),
          makeUnifiedTab({
            id: 'tab-browser-1',
            entityId: browserTabId,
            worktreeId: wt,
            groupId,
            contentType: 'browser'
          })
        ]
      },
      groupsByWorktree: {
        [wt]: [
          makeTabGroup({
            id: groupId,
            worktreeId: wt,
            activeTabId: 'tab-terminal-1',
            tabOrder: ['tab-terminal-1', 'tab-browser-1']
          })
        ]
      },
      activeGroupIdByWorktree: { [wt]: groupId }
    })

    store.getState().setActiveWorktree(wt)

    const s = store.getState()
    expect(s.activeWorktreeId).toBe(wt)
    expect(s.activeTabType).toBe('terminal')
    expect(s.activeTabTypeByWorktree[wt]).toBe('terminal')
    expect(s.activeTabId).toBe(terminalId)
    expect(s.activeBrowserTabId).toBe(browserTabId)
  })
})
