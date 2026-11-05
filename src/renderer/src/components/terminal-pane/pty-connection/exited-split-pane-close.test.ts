import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { sendLayoutCommandToOwner } from '@/runtime/layout-owner-command'
import {
  _resetLayoutOwnerPaneIntentsForTests,
  takePaneCloseIntent
} from '@/runtime/layout-owner-pane-intents'
import { expectExitedSplitPaneClose } from './exited-split-pane-close'

const mocks = vi.hoisted(() => {
  const owner: { pairedServer: string | null } = { pairedServer: null }
  return { sendLayoutCommandToOwner: vi.fn<typeof sendLayoutCommandToOwner>(), owner }
})
vi.mock('@/runtime/layout-owner-command', () => ({
  sendLayoutCommandToOwner: mocks.sendLayoutCommandToOwner
}))
vi.mock('@/lib/resolve-owner', () => ({
  runtimeEnvironmentIdUnlessTwin: () => mocks.owner.pairedServer
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({}) } }))

const LEAF = '11111111-1111-4111-8111-111111111111'

describe('expectExitedSplitPaneClose', () => {
  beforeEach(() => {
    _resetLayoutOwnerPaneIntentsForTests()
    mocks.sendLayoutCommandToOwner.mockReset()
    mocks.owner.pairedServer = null
  })

  it('sends main nothing: main saw the exit and closes the pane, which its frame drops', () => {
    expect(expectExitedSplitPaneClose({ worktreeId: 'wt-1', tabId: 'tab-1', leafId: LEAF })).toBe(
      true
    )
    expect(mocks.sendLayoutCommandToOwner).not.toHaveBeenCalled()
    expect(takePaneCloseIntent('tab-1', LEAF)).toBe('exit')
  })

  it('leaves a paired server’s workspace to today’s close', () => {
    mocks.owner.pairedServer = 'env-1'
    expect(expectExitedSplitPaneClose({ worktreeId: 'wt-1', tabId: 'tab-1', leafId: LEAF })).toBe(
      false
    )
    expect(takePaneCloseIntent('tab-1', LEAF)).toBeNull()
  })
})
