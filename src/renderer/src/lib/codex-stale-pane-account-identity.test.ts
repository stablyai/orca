import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { clearRuntimeCompatibilityCacheForTests } from '@/runtime/runtime-rpc-client'
import { markRestoredStaleCodexSessionsForRestart } from './codex-session-restart'

// Why one shared email: doAddAccount has no duplicate-email check, so one OpenAI
// login used in two ChatGPT workspaces produces two accounts with equal labels.
const SHARED_EMAIL = 'shared@example.com'
const FALLBACK_LABEL = 'Codex account'

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
    clearRuntimeCompatibilityCacheForTests()
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
      pendingCodexPaneRestartIds: {},
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

  it('keeps the prompt when the two accounts resolve to the same label', async () => {
    vi.mocked(window.api.codexAccounts.listStalePanes).mockResolvedValue([
      { ptyId: 'pty-1', launchAccountId: 'account-a', activeAccountId: 'account-b' }
    ])

    const scans = await markRestoredStaleCodexSessionsForRestart()

    expect(noticeFor('pty-1')).toMatchObject({
      previousAccountId: 'account-a',
      nextAccountId: 'account-b'
    })
    expect(scans.find((scan) => scan.ptyId === 'pty-1')?.notified).toBe(true)
  })

  it('keeps the prompt when the roster read fails and every label collapses', async () => {
    vi.mocked(window.api.codexAccounts.list).mockRejectedValue(new Error('roster unavailable'))
    vi.mocked(window.api.codexAccounts.listStalePanes).mockResolvedValue([
      { ptyId: 'pty-1', launchAccountId: 'account-a', activeAccountId: 'account-b' }
    ])

    const scans = await markRestoredStaleCodexSessionsForRestart()

    expect(noticeFor('pty-1')).toMatchObject({
      previousAccountLabel: FALLBACK_LABEL,
      nextAccountLabel: FALLBACK_LABEL,
      previousAccountId: 'account-a',
      nextAccountId: 'account-b'
    })
    expect(scans.find((scan) => scan.ptyId === 'pty-1')?.notified).toBe(true)
  })

  it('disambiguates shared emails by ChatGPT workspace', async () => {
    seedRoster([
      { id: 'account-a', email: SHARED_EMAIL, workspaceLabel: 'Personal' },
      { id: 'account-b', email: SHARED_EMAIL, workspaceLabel: 'Acme' }
    ])
    vi.mocked(window.api.codexAccounts.listStalePanes).mockResolvedValue([
      { ptyId: 'pty-1', launchAccountId: 'account-a', activeAccountId: 'account-b' }
    ])

    await markRestoredStaleCodexSessionsForRestart()

    expect(noticeFor('pty-1')).toMatchObject({
      previousAccountLabel: `${SHARED_EMAIL} (Personal)`,
      nextAccountLabel: `${SHARED_EMAIL} (Acme)`
    })
  })

  it('raises no notice and reports nothing notified for a pane on the selected account', async () => {
    const scans = await markRestoredStaleCodexSessionsForRestart()

    expect(useAppStore.getState().codexRestartNoticeByPtyId).toEqual({})
    expect(scans.every((scan) => scan.notified === false)).toBe(true)
  })

  it('does not report notified for a pane whose notice the store dropped', async () => {
    // The pane already carries a notice remembering account-b as its launch
    // account, so re-marking it against active account-b collapses the notice.
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
    // Why this matters: the sweep permanently suppresses every pane it is told
    // was notified, so a dropped notice must never claim one.
    expect(scans.find((scan) => scan.ptyId === 'pty-1')?.notified).toBe(false)
  })
})
