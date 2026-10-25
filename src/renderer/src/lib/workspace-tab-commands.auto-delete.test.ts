import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeUnifiedTab } from '@/store/slices/store-session-test-harness'

const mocks = vi.hoisted(() => {
  const reaction = vi.fn()
  return {
    reaction,
    capture: vi.fn((..._args: unknown[]) => reaction),
    browserPlan: { closesLocally: true, localCloseReason: 'user' as string }
  }
})

vi.mock('@/components/tab-group/workspace-emptied-reaction', () => ({
  captureWorkspaceEmptiedReaction: mocks.capture
}))
vi.mock('@/components/tab-group/workspace-tab-close-commands', () => ({
  createWorkspaceTabCloseCommands: () => ({
    closeItem: (_id: string, options?: { whenEmptied?: () => void }) => options?.whenEmptied?.()
  })
}))
vi.mock('@/store/pinned-tab-close-guard', () => ({
  guardPinnedTabClose: ({ onClose }: { onClose: () => void }) => onClose(),
  resolvePinnedTabLabel: () => ''
}))
vi.mock('./workspace-browser-tab-close', () => ({
  closeWorkspaceBrowserTab: () => mocks.browserPlan
}))
vi.mock('./browser-workspace-source-resolution', () => ({
  resolveBrowserWorkspaceOwner: () => ({ worktreeId: 'wt-1', workspaceId: 'browser-ws' })
}))

import { dispatchWorkspaceTabCommand } from './workspace-tab-commands'

const editorTab = makeUnifiedTab({
  id: 'tab-1',
  worktreeId: 'wt-1',
  groupId: 'g1',
  contentType: 'editor',
  executionHostId: 'ssh:box'
})
const tabTarget = { kind: 'tab', worktreeId: 'wt-1', tabId: 'tab-1' } as const

describe('dispatchWorkspaceTabCommand auto-delete eligibility', () => {
  beforeEach(() => {
    mocks.capture.mockClear()
    mocks.reaction.mockClear()
    mocks.browserPlan = { closesLocally: true, localCloseReason: 'user' }
    useAppStore.setState({ unifiedTabsByWorktree: { 'wt-1': [editorTab] } })
  })

  it('captures the closing tab host and eligibility for a tab close', () => {
    dispatchWorkspaceTabCommand({ type: 'close', target: tabTarget, autoDeleteEligible: false })
    expect(mocks.capture).toHaveBeenCalledWith('wt-1', {
      floatingPanelGuestOwned: undefined,
      autoDeleteEligible: false,
      hostId: 'ssh:box'
    })
    expect(mocks.reaction).toHaveBeenCalledTimes(1)
  })

  it('carries eligibility into the browser-source branch', () => {
    useAppStore.setState({ unifiedTabsByWorktree: {} })
    dispatchWorkspaceTabCommand({
      type: 'close',
      target: { kind: 'browser-source', sourceId: 'page' },
      autoDeleteEligible: false
    })
    expect(mocks.capture).toHaveBeenCalledWith('wt-1', { autoDeleteEligible: false })
  })

  it('runs no reaction for bulk and skip-empty-check closes', () => {
    dispatchWorkspaceTabCommand({ type: 'close', target: tabTarget, bulk: true })
    dispatchWorkspaceTabCommand({ type: 'close', target: tabTarget, skipEmptyCheck: true })
    expect(mocks.capture).not.toHaveBeenCalled()
  })

  it('runs no reaction for a browser cleanup close', () => {
    useAppStore.setState({ unifiedTabsByWorktree: {} })
    mocks.browserPlan = { closesLocally: true, localCloseReason: 'cleanup' }
    dispatchWorkspaceTabCommand({
      type: 'close',
      target: { kind: 'browser-source', sourceId: 'p' }
    })
    expect(mocks.reaction).not.toHaveBeenCalled()
  })
})
