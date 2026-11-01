// Exercise main-owned moves through the real frame transport and its full-build parity check.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { useAppStore } from '@/store'
import { localDesktopSession } from '../../../../shared/workspace-layout/workspace-layout-profile.test-fixture'
import { GIT_KEY } from '../../../../shared/workspace-layout/workspace-layout-session.test-fixture'
import { bootWindowFromPartitions } from '../../app-shell/startup-window-view.test-fixture'
import { createStoreSessionMockApi } from '../../store/slices/store-session-test-harness'
import { layoutApplyTestTransport } from '@/runtime/layout-apply-test-transport.test-fixture'
import { loadMainLayoutModel } from '@/runtime/main-loaded-layout-frames.test-fixture'
import { endLayoutFramePositions } from '@/runtime/layout-frame-position'
import { openWorkspaceLayoutFrameSync } from '@/runtime/workspace-layout-frame-sync'
import { dropTabThroughLayoutOwner } from './tab-group-layout-owner-commands'
import { moveTabToNewPaneColumn } from '../tab-bar/tab-move-to-pane-column'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))
// Simulate main’s layout-command answers and frames.
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)
vi.mock('@/runtime/runtime-layout-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeLayoutClientWithTestFrames(await importOriginal())
)
// The test opens its own stream: boot's document-long one would outlive the test's transport.
vi.mock('@/runtime/workspace-layout-frame-sync', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  showStartupLayoutFrames: () => {}
}))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return { ...actual, detectAgentStatusFromTitle: vi.fn().mockReturnValue(null) }
})

createStoreSessionMockApi()

const settle = async (): Promise<void> => {
  await layoutApplyTestTransport.settle()
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

let close = (): void => {}

/** The window's own tab moves and selections; main's frame does both, so each stays 0. */
const WINDOW_TAB_WRITERS = [
  'dropUnifiedTab',
  'reorderUnifiedTabs',
  'moveUnifiedTabToGroup',
  'activateTab',
  'focusGroup'
] as const
let windowTabWrites = (): number => 0

beforeEach(async () => {
  layoutApplyTestTransport.reset()
  const session = localDesktopSession()
  layoutApplyTestTransport.useMainModel(loadMainLayoutModel('local', session))
  layoutApplyTestTransport.answerWith('apply')
  await bootWindowFromPartitions(useAppStore, [{ hostId: 'local', session }])
  const sync = openWorkspaceLayoutFrameSync(useAppStore)
  sync.start()
  await settle()
  close = () => sync.close()
  const state = useAppStore.getState()
  // Store actions are copied into each new state, so a spy outlives its test; count from here.
  const spies = WINDOW_TAB_WRITERS.map((name) =>
    vi.isMockFunction(state[name]) ? state[name] : vi.spyOn(state, name)
  )
  const before = spies.map((spy) => spy.mock.calls.length)
  windowTabWrites = () =>
    spies.reduce((count, spy, index) => count + spy.mock.calls.length - before[index]!, 0)
})

afterEach(() => {
  close()
  endLayoutFramePositions()
})

const tabOf = (tabId: string) =>
  useAppStore.getState().unifiedTabsByWorktree[GIT_KEY]!.find((tab) => tab.id === tabId)!
const groupOf = (groupId: string) =>
  useAppStore.getState().groupsByWorktree[GIT_KEY]!.find((group) => group.id === groupId)
const mainGroupOf = (tabId: string) =>
  layoutApplyTestTransport.mainModel!.workspaces[GIT_KEY]!.groups.find((group) =>
    group.tabOrder.includes(tabId)
  )!

describe('a tab move drawn from main’s frame', () => {
  it('moves the tab into another group where main placed it, and selects it there', async () => {
    expect(
      dropTabThroughLayoutOwner(GIT_KEY, {
        kind: 'move',
        tabId: 'tab-unbound',
        groupId: 'group-a',
        index: 0
      })
    ).toBe(true)
    await settle()

    expect(tabOf('tab-unbound').groupId).toBe('group-a')
    expect(groupOf('group-a')!.tabOrder).toEqual(mainGroupOf('tab-unbound').tabOrder)
    expect(groupOf('group-a')!.tabOrder[0]).toBe('tab-unbound')
    expect(groupOf('group-a')!.activeTabId).toBe('tab-unbound')
    expect(useAppStore.getState().activeGroupIdByWorktree[GIT_KEY]).toBe('group-a')
    expect(windowTabWrites()).toBe(0)
  })

  it('selects the moved tab in the same store update that shows the move (L120)', async () => {
    const updates: { groupId: string; activeGroupId?: string; activeTabId?: string | null }[] = []
    const stop = useAppStore.subscribe((state, previous) => {
      const tab = state.unifiedTabsByWorktree[GIT_KEY]!.find((entry) => entry.id === 'tab-unbound')
      const before = previous.unifiedTabsByWorktree[GIT_KEY]!.find(
        (entry) => entry.id === 'tab-unbound'
      )
      if (tab && tab.groupId !== before?.groupId) {
        updates.push({
          groupId: tab.groupId,
          activeGroupId: state.activeGroupIdByWorktree[GIT_KEY],
          activeTabId: state.groupsByWorktree[GIT_KEY]!.find((group) => group.id === tab.groupId)
            ?.activeTabId
        })
      }
    })
    dropTabThroughLayoutOwner(GIT_KEY, { kind: 'move', tabId: 'tab-unbound', groupId: 'group-a' })
    await settle()
    stop()

    expect(updates).toEqual([
      { groupId: 'group-a', activeGroupId: 'group-a', activeTabId: 'tab-unbound' }
    ])
  })

  it('keeps a selection the user made before main’s answer to an earlier drag (L120)', async () => {
    layoutApplyTestTransport.answerWith('pending')
    dropTabThroughLayoutOwner(GIT_KEY, { kind: 'move', tabId: 'tab-unbound', groupId: 'group-a' })
    await Promise.resolve()
    // A second drag starts and selects elsewhere before main answers the first.
    useAppStore.getState().focusGroup(GIT_KEY, 'group-b')
    const selected = useAppStore
      .getState()
      .groupsByWorktree[GIT_KEY]!.map((group) => [group.id, group.activeTabId])
    layoutApplyTestTransport.answerWith('apply')
    layoutApplyTestTransport.answerPending()
    await settle()

    expect(tabOf('tab-unbound').groupId).toBe('group-a')
    expect(useAppStore.getState().activeGroupIdByWorktree[GIT_KEY]).toBe('group-b')
    expect(groupOf('group-a')!.activeTabId).toBe(selected.find(([id]) => id === 'group-a')![1])
  })

  it('splits the tab into the group main made beside its target, and selects it there', async () => {
    const groupsBefore = useAppStore.getState().groupsByWorktree[GIT_KEY]!.map((group) => group.id)
    dropTabThroughLayoutOwner(GIT_KEY, {
      kind: 'split',
      tabId: 'tab-unbound',
      groupId: 'group-a',
      direction: 'right'
    })
    await settle()

    const mainGroup = mainGroupOf('tab-unbound')
    expect(groupsBefore).not.toContain(mainGroup.id)
    expect(tabOf('tab-unbound').groupId).toBe(mainGroup.id)
    expect(groupOf(mainGroup.id)!.tabOrder).toEqual(['tab-unbound'])
    expect(useAppStore.getState().layoutByWorktree[GIT_KEY]).toEqual(
      layoutApplyTestTransport.mainModel!.workspaces[GIT_KEY]!.groupLayout
    )
    expect(useAppStore.getState().activeGroupIdByWorktree[GIT_KEY]).toBe(mainGroup.id)
    expect(windowTabWrites()).toBe(0)
  })

  it('moves a tab to a split from its menu where main placed it', async () => {
    expect(
      moveTabToNewPaneColumn({ unifiedTabId: 'tab-shell', groupId: 'group-a', direction: 'down' })
    ).toBe(true)
    await settle()

    expect(layoutApplyTestTransport.sentOfType('splitGroup')).toEqual([
      expect.objectContaining({ tabId: 'tab-shell', besideGroupId: 'group-a', direction: 'down' })
    ])
    const mainGroup = mainGroupOf('tab-shell')
    expect(mainGroup.id).not.toBe('group-a')
    expect(tabOf('tab-shell').groupId).toBe(mainGroup.id)
    expect(useAppStore.getState().activeGroupIdByWorktree[GIT_KEY]).toBe(mainGroup.id)
    expect(windowTabWrites()).toBe(0)
  })

  it('reorders the tab within its group as main ordered it', async () => {
    dropTabThroughLayoutOwner(GIT_KEY, {
      kind: 'reorder',
      tabId: 'tab-shell',
      groupId: 'group-a',
      tabOrder: ['tab-agent', 'tab-shell', 'editor:src/app.ts']
    })
    await settle()

    expect(groupOf('group-a')!.tabOrder).toEqual(['tab-agent', 'tab-shell', 'editor:src/app.ts'])
    expect(windowTabWrites()).toBe(0)
  })
})
