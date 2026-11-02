import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { sendLayoutApply } from '@/runtime/layout-apply-send'
import { recordTerminalTabCloseThroughLayoutOwner } from './terminal-tab-close-layout-owner'

const mocks = vi.hoisted(() => ({
  send: vi.fn<typeof sendLayoutApply>(),
  commit: vi.fn()
}))

vi.mock('@/runtime/layout-apply-send', () => ({ sendLayoutApply: mocks.send }))
vi.mock('./terminal-surface-close-intent', () => ({ commitTerminalSurfaceClose: mocks.commit }))

const WT = 'repo1::/path/wt1'
const STATE = {
  unifiedTabsByWorktree: {
    [WT]: [
      {
        id: 'entry-legacy',
        entityId: 'term-legacy',
        contentType: 'terminal' as const,
        groupId: 'g1',
        worktreeId: WT,
        label: 'Terminal',
        customLabel: null,
        color: null,
        sortOrder: 0,
        createdAt: 1
      }
    ]
  }
}

describe('recordTerminalTabCloseThroughLayoutOwner', () => {
  beforeEach(() => {
    mocks.send.mockReset()
    mocks.commit.mockReset()
    mocks.send.mockReturnValue(true)
  })

  it('names the tab by its tab-bar entry and keeps the window’s reason', () => {
    expect(recordTerminalTabCloseThroughLayoutOwner(STATE, WT, 'term-legacy', 'cleanup')).toBe(true)

    expect(mocks.send).toHaveBeenCalledWith(
      STATE,
      WT,
      { type: 'closeTabs', tabIds: ['entry-legacy'], recordClose: 'cleanup' },
      expect.anything()
    )
    expect(mocks.commit).not.toHaveBeenCalled()
  })

  it('records the close as today when main cannot', () => {
    recordTerminalTabCloseThroughLayoutOwner(STATE, WT, 'term-new', 'user')
    expect(mocks.send.mock.calls[0]![2]).toMatchObject({ tabIds: ['term-new'] })

    mocks.send.mock.calls[0]![3].asToday()

    expect(mocks.commit).toHaveBeenCalledWith(WT, { kind: 'tab', tabId: 'term-new' }, 'user')
  })
})
