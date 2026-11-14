import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  initWorkspacePopoutState,
  isTabPoppedOut,
  getPoppedOutTabId,
  setPopoutState
} from './workspace-popout-state'

describe('workspace-popout-state', () => {
  beforeEach(() => {
    setPopoutState('wt-1', 'tab-1', false)
    setPopoutState('wt-2', 'tab-2', false)
  })

  afterEach(() => {
    // @ts-expect-error clean up global
    delete globalThis.window
  })

  it('records popout state correctly', () => {
    expect(isTabPoppedOut('tab-1')).toBe(false)
    expect(getPoppedOutTabId('wt-1')).toBe(null)

    setPopoutState('wt-1', 'tab-1', true)

    expect(isTabPoppedOut('tab-1')).toBe(true)
    expect(getPoppedOutTabId('wt-1')).toBe('tab-1')

    setPopoutState('wt-1', 'tab-1', false)

    expect(isTabPoppedOut('tab-1')).toBe(false)
    expect(getPoppedOutTabId('wt-1')).toBe(null)
  })

  it('hydrates initial state from list API', async () => {
    const listMock = vi
      .fn()
      .mockResolvedValue([{ worktreeId: 'wt-2', tabId: 'tab-2', ptyId: 'pty-2', state: 'open' }])
    const onStateChangedMock = vi.fn().mockReturnValue(() => undefined)

    // Mock window for node environment
    globalThis.window = {
      api: {
        workspacePopout: {
          list: listMock,
          onStateChanged: onStateChangedMock
        }
      }
    } as unknown as Window & typeof globalThis

    initWorkspacePopoutState()
    await vi.waitFor(() => {
      expect(isTabPoppedOut('tab-2')).toBe(true)
    })
    expect(getPoppedOutTabId('wt-2')).toBe('tab-2')
  })
})
