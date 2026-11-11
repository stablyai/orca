import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { clearRuntimeCompatibilityCache } from '@/runtime/rpc/compatibility/runtime-compatibility-cache'
import { markRestoredStaleCodexSessionsForRestart } from './codex-session-restart'

// One login can produce separate ChatGPT-workspace accounts with the same email label.
const SHARED_EMAIL = 'shared@example.com'

function seedRoster(
  accounts: { id: string; email: string; workspaceLabel?: string | null }[]
): void {
  vi.mocked(window.api.codexAccounts.list).mockResolvedValue({
    accounts,
    activeAccountId: 'account-b'
  } as never)
}

function noticeFor(ptyId: string): unknown {
  return useAppStore.getState().codexRestartNoticeByPtyId[ptyId]
}

describe('stale Codex panes are decided by account id, not label', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window

  beforeEach(() => {
    clearRuntimeCompatibilityCache()
    useAppStore.setState({
      settings: null as never,
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab-1',
            ptyId: 'pty-1',
            worktreeId: 'wt1',
            title: 'orca-1',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-1'] },
      pendingPaneAccountRestarts: {},
      codexRestartNoticeByPtyId: {}
    })
    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          getForegroundProcess: vi.fn(),
          hasChildProcesses: vi.fn().mockResolvedValue(false),
          inspectProcess: vi
            .fn()
            .mockResolvedValue({ foregroundProcess: 'codex', hasChildProcesses: false }),
          confirmForegroundProcess: vi.fn().mockResolvedValue(null)
        },
        codexAccounts: {
          ...originalWindow?.api?.codexAccounts,
          list: vi.fn(),
          listStalePanes: vi.fn().mockResolvedValue([])
        }
      }
    } as unknown as typeof window
    seedRoster([
      { id: 'account-a', email: SHARED_EMAIL },
      { id: 'account-b', email: SHARED_EMAIL }
    ])
  })

  afterEach(() => {
    if (originalWindow) {
      ;(globalThis as { window: typeof window }).window = originalWindow
    } else {
      delete (globalThis as { window?: typeof window }).window
    }
  })

  it('does not report notified for a pane whose notice the store dropped', async () => {
    // The existing notice remembers account-b as launch account, so re-marking against active account-b collapses it.
    useAppStore.setState({
      codexRestartNoticeByPtyId: {
        'pty-1': {
          previousAccountLabel: SHARED_EMAIL,
          nextAccountLabel: SHARED_EMAIL,
          previousAccountId: 'account-b',
          nextAccountId: 'account-a'
        }
      }
    })
    vi.mocked(window.api.codexAccounts.listStalePanes).mockResolvedValue([
      { ptyId: 'pty-1', launchAccountId: 'account-a', activeAccountId: 'account-b' }
    ])

    const scans = await markRestoredStaleCodexSessionsForRestart()

    expect(noticeFor('pty-1')).toBeUndefined()
    // Do not claim dropped notices: the sweep permanently suppresses panes it considers notified.
    expect(scans.find((scan) => scan.ptyId === 'pty-1')?.notified).toBe(false)
  })
})
