import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { markLiveCodexSessionsForRestart } from './codex-session-restart'

describe('markLiveCodexSessionsForRestart', () => {
  const originalWindow = (globalThis as { window?: typeof window }).window

  beforeEach(() => {
    useAppStore.setState({
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
      ptyIdsByTabId: {
        'tab-1': ['pty-1']
      },
      codexRestartNoticeByPtyId: {},
      markCodexRestartNotices: useAppStore.getState().markCodexRestartNotices
    })

    ;(globalThis as { window: typeof window }).window = {
      ...originalWindow,
      api: {
        ...originalWindow?.api,
        pty: {
          ...originalWindow?.api?.pty,
          getForegroundProcess: vi.fn()
        }
      }
    } as unknown as typeof window
  })

  afterEach(() => {
    if (originalWindow) {
      ;(globalThis as { window: typeof window }).window = originalWindow
    } else {
      delete (globalThis as { window?: typeof window }).window
    }
  })

  it('marks a live Codex PTY for restart', async () => {
    vi.mocked(window.api.pty.getForegroundProcess).mockResolvedValue('codex')

    await markLiveCodexSessionsForRestart({
      previousAccountLabel: 'hong@stably.ai',
      nextAccountLabel: 'jinwoo@stably.ai'
    })

    expect(window.api.pty.getForegroundProcess).toHaveBeenCalledWith('pty-1')
    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: 'hong@stably.ai',
      nextAccountLabel: 'jinwoo@stably.ai'
    })
  })

  it('does not mark non-codex foreground processes', async () => {
    vi.mocked(window.api.pty.getForegroundProcess).mockResolvedValue('zsh')

    await markLiveCodexSessionsForRestart({
      previousAccountLabel: 'hong@stably.ai',
      nextAccountLabel: 'jinwoo@stably.ai'
    })

    expect(useAppStore.getState().codexRestartNoticeByPtyId).toEqual({})
  })

  it('treats codex.exe as codex for Windows PTYs', async () => {
    vi.mocked(window.api.pty.getForegroundProcess).mockResolvedValue('codex.exe')

    await markLiveCodexSessionsForRestart({
      previousAccountLabel: 'hong@stably.ai',
      nextAccountLabel: 'jinwoo@stably.ai'
    })

    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: 'hong@stably.ai',
      nextAccountLabel: 'jinwoo@stably.ai'
    })
  })

  it('treats codex-prefixed packaged binaries as codex', async () => {
    vi.mocked(window.api.pty.getForegroundProcess).mockResolvedValue('codex-aarch64-ap')

    await markLiveCodexSessionsForRestart({
      previousAccountLabel: 'hong@stably.ai',
      nextAccountLabel: 'jinwoo@stably.ai'
    })

    expect(useAppStore.getState().codexRestartNoticeByPtyId['pty-1']).toEqual({
      previousAccountLabel: 'hong@stably.ai',
      nextAccountLabel: 'jinwoo@stably.ai'
    })
  })
})
