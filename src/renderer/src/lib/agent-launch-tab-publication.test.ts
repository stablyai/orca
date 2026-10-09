import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import type { AgentLaunchTabPublishRequest } from '../../../shared/agent-launch-tab-publication'
import { createTabsSliceMockApi } from '../store/slices/tabs-slice-test-harness'
import { createTestStore } from '../store/slices/store-test-helpers'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))
vi.mock('@/lib/agent-status', async (importOriginal) => ({
  ...(await importOriginal<typeof AgentStatusModule>()),
  detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
}))

const testStore = vi.hoisted(() => {
  const ref: { current: ReturnType<typeof createTestStore> | null } = { current: null }
  return ref
})
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => {
      if (!testStore.current) {
        throw new Error('no test store')
      }
      return testStore.current.getState()
    }
  }
}))
const focusTerminalInitiatedTab = vi.hoisted(() => vi.fn())
vi.mock('@/hooks/ipc-events/terminal-command-state', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  focusTerminalInitiatedTab
}))

createTabsSliceMockApi()

const { publishAgentLaunchTab } = await import('./agent-launch-tab-publication')
const { agentLaunchPanePrompt } = await import('./agent-launch-pane-prompt')

const WT = 'repo1::/tmp/feature'
const OTHER_WT = 'repo1::/tmp/other'
const TAB_ID = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d'
const LEAF_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

let store: ReturnType<typeof createTestStore>

function request(
  overrides: Partial<AgentLaunchTabPublishRequest> = {}
): AgentLaunchTabPublishRequest {
  return {
    requestId: 'request-1',
    worktreeId: WT,
    tabId: TAB_ID,
    leafId: LEAF_ID,
    launchAgent: 'claude',
    viewMode: 'terminal',
    viewer: 'none',
    ...overrides
  }
}

function launchTab() {
  return store.getState().unifiedTabsByWorktree[WT]?.find((tab) => tab.entityId === TAB_ID)
}

beforeEach(() => {
  store = createTestStore()
  testStore.current = store
  focusTerminalInitiatedTab.mockClear()
  store.getState().setActiveWorktree(WT)
})

describe('publishing a launch tab before its agent exists', () => {
  it('creates the tab under the host ids with its one pane laid out and no process', () => {
    const published = publishAgentLaunchTab(request({ viewMode: 'chat' }))

    expect(published.created).toBe(true)
    expect(published.tabId).toBe(TAB_ID)
    const terminal = store.getState().tabsByWorktree[WT]?.find((tab) => tab.id === TAB_ID)
    // The tab remembers which pane a launch laid out, so after a restart that pane reads the record.
    expect(terminal).toMatchObject({
      ptyId: null,
      launchAgent: 'claude',
      agentLaunchPane: { leafId: LEAF_ID }
    })
    expect(store.getState().terminalLayoutsByTabId[TAB_ID]?.root).toEqual({
      type: 'leaf',
      leafId: LEAF_ID
    })
    expect(launchTab()?.viewMode).toBe('chat')
  })

  it('keeps the prompt for the pane to offer if its agent does not start', () => {
    publishAgentLaunchTab(request({ prompt: 'fix the build' }))
    expect(agentLaunchPanePrompt(TAB_ID)).toBe('fix the build')
  })

  it('never makes a second tab when a retry names the same one', () => {
    publishAgentLaunchTab(request())
    const again = publishAgentLaunchTab(request({ requestId: 'request-2' }))

    expect(again).toMatchObject({ tabId: TAB_ID, created: false })
    expect(store.getState().tabsByWorktree[WT]?.filter((tab) => tab.id === TAB_ID)).toHaveLength(1)
  })

  it("keeps a launch's final outcome on a retry of that launch; a different launch resets it", () => {
    const launchPane = () =>
      store.getState().tabsByWorktree[WT]?.find((tab) => tab.id === TAB_ID)?.agentLaunchPane
    publishAgentLaunchTab(request({ operationId: 'op-1' }))
    store.getState().setTabAgentLaunchPane(TAB_ID, {
      leafId: LEAF_ID,
      operationId: 'op-1',
      outcome: { kind: 'unconfirmed' }
    })

    publishAgentLaunchTab(request({ requestId: 'request-2', operationId: 'op-1' }))
    expect(launchPane()).toEqual({
      leafId: LEAF_ID,
      operationId: 'op-1',
      outcome: { kind: 'unconfirmed' }
    })

    publishAgentLaunchTab(request({ requestId: 'request-3', operationId: 'op-2' }))
    expect(launchPane()).toEqual({ leafId: LEAF_ID, operationId: 'op-2' })
  })

  it('hands a tab this window made for the launch to the host, as the launch to take back', async () => {
    const { holdAgentLaunchPaneSpawn, agentLaunchPaneSpawnHold } =
      await import('./agent-launch-pane-spawn-hold')
    holdAgentLaunchPaneSpawn(TAB_ID, LEAF_ID)
    store.getState().createTab(WT, undefined, undefined, {
      id: TAB_ID,
      initialLeafId: LEAF_ID,
      agentLaunchPane: { leafId: LEAF_ID }
    })
    const held = agentLaunchPaneSpawnHold(TAB_ID, LEAF_ID)

    const published = publishAgentLaunchTab(request())

    // The host now owns the pane, so a refused launch takes the tab back rather than leaving a shell.
    expect(published).toMatchObject({ tabId: TAB_ID, created: true })
    await expect(held).resolves.toBeUndefined()
    expect(agentLaunchPaneSpawnHold(TAB_ID, LEAF_ID)).toBeNull()
    // A retry finds no hold: the tab is no longer only this launch's.
    expect(publishAgentLaunchTab(request({ requestId: 'request-2' })).created).toBe(false)
  })

  it("remounts a pane that showed an earlier launch's outcome, so it spawns for the new launch", () => {
    const generation = () =>
      store.getState().tabsByWorktree[WT]?.find((tab) => tab.id === TAB_ID)?.generation ?? 0
    publishAgentLaunchTab(request({ operationId: 'op-1' }))
    // Its spawn was refused ("couldn't confirm"): the pane is idle until it remounts.
    store.getState().setTabAgentLaunchPane(TAB_ID, {
      leafId: LEAF_ID,
      operationId: 'op-1',
      outcome: { kind: 'unconfirmed' }
    })
    const before = generation()

    publishAgentLaunchTab(request({ requestId: 'request-2', operationId: 'op-1' }))
    expect(generation()).toBe(before)

    publishAgentLaunchTab(request({ requestId: 'request-3', operationId: 'op-2' }))
    expect(generation()).toBe(before + 1)
    // A pane still waiting on a launch is spawning already: another launch does not remount it.
    publishAgentLaunchTab(request({ requestId: 'request-4', operationId: 'op-3' }))
    expect(generation()).toBe(before + 1)
  })

  it("refuses a tab id another workspace already uses rather than minting one the agent won't find", () => {
    store.getState().createTab(OTHER_WT, undefined, undefined, { id: TAB_ID })

    expect(() => publishAgentLaunchTab(request())).toThrow('agent_launch_tab_id_taken')
    expect(store.getState().tabsByWorktree[WT] ?? []).toEqual([])
  })
})

describe('placement', () => {
  function twoGroups() {
    const anchor = store.getState().createUnifiedTab(WT, 'terminal')
    const sourceGroupId = store.getState().groupsByWorktree[WT]![0]!.id
    const splitGroupId = store.getState().createEmptySplitGroup(WT, sourceGroupId, 'right')!
    return { anchor, sourceGroupId, splitGroupId }
  }

  it('lands in the requested group', () => {
    const { sourceGroupId, splitGroupId } = twoGroups()
    store.getState().focusGroup(WT, sourceGroupId)

    const published = publishAgentLaunchTab(request({ placement: { groupId: splitGroupId } }))

    expect(published.placement).toEqual({ groupId: splitGroupId })
    expect(launchTab()?.groupId).toBe(splitGroupId)
  })

  // Activating a workspace with a live tab prunes its empty groups; a CLI's focused launch activates
  // it, and the split it asked for must still be there to receive the tab.
  it.each(
    (['none', 'focus-window', 'focus-in-workspace', 'reveal-owner'] as const).flatMap((viewer) => [
      { viewer, focused: 'split' as const },
      { viewer, focused: 'source' as const }
    ])
  )(
    'lands in a just-created empty split beside a live terminal for a $viewer caller ($focused focused)',
    ({ viewer, focused }) => {
      store.getState().createTab(WT)
      const sourceGroupId = store.getState().groupsByWorktree[WT]![0]!.id
      const splitGroupId = store.getState().createEmptySplitGroup(WT, sourceGroupId, 'right')!
      store.getState().focusGroup(WT, focused === 'split' ? splitGroupId : sourceGroupId)

      const published = publishAgentLaunchTab(
        request({ viewer, placement: { groupId: splitGroupId } })
      )

      expect(published.placement).toEqual({ groupId: splitGroupId })
      expect(launchTab()?.groupId).toBe(splitGroupId)
      expect(store.getState().groupsByWorktree[WT]?.map((group) => group.id)).toContain(
        splitGroupId
      )
    }
  )

  it("falls back to the anchor's group when the requested group is gone", () => {
    const { anchor, sourceGroupId } = twoGroups()

    const published = publishAgentLaunchTab(
      request({ placement: { groupId: 'group-closed', afterTabId: anchor.id } })
    )

    expect(published.placement).toEqual({ groupId: sourceGroupId, fallback: 'anchor-group' })
    const order = store
      .getState()
      .groupsByWorktree[WT]!.find((g) => g.id === sourceGroupId)!.tabOrder
    expect(order.indexOf(launchTab()!.id)).toBe(order.indexOf(anchor.id) + 1)
  })

  it('then to the active group, and the launch still gets its tab', () => {
    const { splitGroupId } = twoGroups()

    const published = publishAgentLaunchTab(request({ placement: { groupId: 'group-closed' } }))

    expect(published.placement).toEqual({ groupId: splitGroupId, fallback: 'active-group' })
    expect(launchTab()?.groupId).toBe(splitGroupId)
  })
})

describe('a focused launch into a workspace with no live terminal', () => {
  it('is the agent starting, not a wake: its first bind moves the workspace up in Recent', () => {
    store.getState().setActiveWorktree(OTHER_WT)
    publishAgentLaunchTab(request({ viewer: 'focus-window' }))
    const tab = store.getState().tabsByWorktree[WT]?.find((candidate) => candidate.id === TAB_ID)
    expect(tab?.pendingActivationSpawn).toBeUndefined()
    expect(tab?.generation).toBeUndefined()

    const epoch = store.getState().sortEpoch
    store.getState().updateTabPtyId(TAB_ID, 'pty-agent-1')

    expect(store.getState().sortEpoch).toBe(epoch + 1)
  })
})

describe('whose view moves', () => {
  it('none: the window stays where it is', () => {
    const before = store.getState().activeTabIdByWorktree[WT]
    store.getState().setActiveWorktree(OTHER_WT)

    publishAgentLaunchTab(request({ viewer: 'none' }))

    expect(store.getState().activeWorktreeId).toBe(OTHER_WT)
    expect(focusTerminalInitiatedTab).not.toHaveBeenCalled()
    expect(store.getState().activeTabIdByWorktree[WT] ?? null).toBe(before ?? TAB_ID)
  })

  it('focus-window: the window goes to the workspace and the tab', () => {
    store.getState().setActiveWorktree(OTHER_WT)

    publishAgentLaunchTab(request({ viewer: 'focus-window' }))

    expect(store.getState().activeWorktreeId).toBe(WT)
    expect(store.getState().activeTabId).toBe(TAB_ID)
    expect(focusTerminalInitiatedTab).toHaveBeenCalledWith(TAB_ID, LEAF_ID, WT)
  })

  it('focus-in-workspace: the desktop stays put when you have moved to another workspace', () => {
    store.getState().setActiveWorktree(OTHER_WT)

    publishAgentLaunchTab(request({ viewer: 'focus-in-workspace' }))

    expect(store.getState().activeWorktreeId).toBe(OTHER_WT)
    expect(store.getState().activeTabIdByWorktree[WT]).toBe(TAB_ID)
    expect(focusTerminalInitiatedTab).not.toHaveBeenCalled()
  })

  it('focus-in-workspace: the tab is focused when you are still there', () => {
    publishAgentLaunchTab(request({ viewer: 'focus-in-workspace' }))

    expect(store.getState().activeWorktreeId).toBe(WT)
    expect(store.getState().activeTabId).toBe(TAB_ID)
    expect(focusTerminalInitiatedTab).toHaveBeenCalledWith(TAB_ID, LEAF_ID, WT)
  })
})
