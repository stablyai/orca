import { afterEach, describe, expect, it, vi } from 'vitest'
import { setupTerminalCreateSurfacing } from './ipc-events-terminal-create-test-harness'
import type { TerminalCreateListenerPayload } from './ipc-events-terminal-create-scenario-types'
import type { TerminalLayoutSnapshot } from '../../../shared/terminal-tab-types'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { parseWorkspaceSession } from '../../../shared/workspace-session-schema'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

const TAB_ID = 'tab-existing'
const SOURCE = '11111111-1111-4111-8111-111111111111'
const NEW_LEAF = '22222222-2222-4222-8222-222222222222'
const SIBLING = '33333333-3333-4333-8333-333333333333'
const LAUNCH_CONFIG = { agentArgs: '--resume fixture-session', agentEnv: {} }

async function scenario() {
  const harness = await setupTerminalCreateSurfacing(() => false)
  const layout: TerminalLayoutSnapshot = {
    root: {
      type: 'split',
      direction: 'horizontal',
      ratio: 0.7,
      first: { type: 'leaf', leafId: SIBLING },
      second: { type: 'leaf', leafId: SOURCE }
    },
    activeLeafId: SIBLING,
    expandedLeafId: null,
    ptyIdsByLeafId: { [SIBLING]: 'pty-sibling', [SOURCE]: 'pty-source' },
    titlesByLeafId: { [SIBLING]: 'Keep sibling title', [SOURCE]: 'Keep source title' }
  }
  harness.storeState.tabsByWorktree = {
    'wt-2': [{ id: TAB_ID, ptyId: 'pty-source', title: 'Terminal 1' }]
  }
  harness.storeState.ptyIdsByTabId = { [TAB_ID]: ['pty-source', 'pty-sibling'] }
  harness.storeState.terminalLayoutsByTabId = { [TAB_ID]: layout }
  const reveal = (ratio?: number, options: Partial<TerminalCreateListenerPayload> = {}) =>
    harness.createTerminalListenerRef.current?.({
      requestId: 'req-ratio',
      worktreeId: 'wt-2',
      tabId: TAB_ID,
      leafId: NEW_LEAF,
      ptyId: 'pty-new',
      splitFromLeafId: SOURCE,
      splitDirection: 'vertical',
      ...(ratio !== undefined ? { splitRatio: ratio } : {}),
      activate: false,
      presentation: 'background',
      ...options
    })
  return { ...harness, layout, reveal }
}

async function nativePtyBindings(
  harness: Awaited<ReturnType<typeof scenario>>,
  layout: TerminalLayoutSnapshot
) {
  const { createTestStore, makeTab, makeWorktree, seedStore } =
    await import('../store/slices/store-test-helpers')
  const store = createTestStore()
  seedStore(store, {
    tabsByWorktree: {
      'wt-2': harness.storeState.tabsByWorktree['wt-2'].map((tab) =>
        makeTab({ ...tab, worktreeId: 'wt-2' })
      )
    },
    ptyIdsByTabId: harness.storeState.ptyIdsByTabId,
    terminalLayoutsByTabId: { [TAB_ID]: layout },
    worktreesByRepo: { repo1: [makeWorktree({ id: 'wt-2', repoId: 'repo1' })] }
  })
  harness.storeState.tabsByWorktree = store.getState().tabsByWorktree
  harness.updateTabPtyId.mockImplementation((tabId, ptyId) => {
    store.getState().updateTabPtyId(tabId, ptyId)
    harness.storeState.tabsByWorktree = store.getState().tabsByWorktree
    harness.storeState.ptyIdsByTabId = store.getState().ptyIdsByTabId
  })
  return store
}

describe('local split ratio reveal consumption', () => {
  it('sets only the new source split and passes the ratio to the mounted pane event', async () => {
    const harness = await scenario()
    harness.reveal(0.85)
    expect(harness.storeState.terminalLayoutsByTabId[TAB_ID]).toEqual({
      ...harness.layout,
      root: {
        type: 'split',
        direction: 'horizontal',
        ratio: 0.7,
        first: { type: 'leaf', leafId: SIBLING },
        second: {
          type: 'split',
          direction: 'vertical',
          ratio: 0.85,
          first: { type: 'leaf', leafId: SOURCE },
          second: { type: 'leaf', leafId: NEW_LEAF }
        }
      },
      ptyIdsByLeafId: { [SIBLING]: 'pty-sibling', [SOURCE]: 'pty-source', [NEW_LEAF]: 'pty-new' }
    })
    expect(harness.dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'orca-split-terminal-pane',
        detail: expect.objectContaining({
          ratio: 0.85,
          sourceLeafId: SOURCE,
          newLeafId: NEW_LEAF,
          ptyId: 'pty-new'
        })
      })
    )
    expect(harness.queueTabStartupCommand).not.toHaveBeenCalled()
    expect(harness.replyTerminalCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req-ratio',
        tabId: TAB_ID,
        identity: expect.objectContaining({ leafId: NEW_LEAF })
      })
    )
  })

  it('preserves a user-changed ratio when the same leaf is revealed again', async () => {
    const harness = await scenario()
    harness.reveal(0.85)
    const saved = JSON.stringify({
      ...getDefaultWorkspaceSession(),
      terminalLayoutsByTabId: harness.storeState.terminalLayoutsByTabId
    })
    const restored = parseWorkspaceSession(JSON.parse(saved))
    if (!restored.ok) {
      throw new Error(restored.error)
    }
    const created = restored.value.terminalLayoutsByTabId[TAB_ID]
    if (created?.root?.type !== 'split' || created.root.second.type !== 'split') {
      throw new Error('nested split was not created')
    }
    expect(created.root.second.ratio).toBe(0.85)
    created.root.second.ratio = 0.63
    harness.storeState.terminalLayoutsByTabId[TAB_ID] = created
    harness.reveal(0.85)
    expect(harness.storeState.terminalLayoutsByTabId[TAB_ID]).toEqual(created)
  })

  it('keeps the omitted-ratio reveal at the existing equal default', async () => {
    const harness = await scenario()
    harness.reveal()
    expect(harness.storeState.terminalLayoutsByTabId[TAB_ID]).toMatchObject({
      root: { ratio: 0.7, second: { ratio: 0.5 } }
    })
    const splitEvent = harness.dispatchEvent.mock.calls.find(
      (call) => call[0] instanceof CustomEvent && call[0].type === 'orca-split-terminal-pane'
    )?.[0]
    expect(splitEvent).toBeInstanceOf(CustomEvent)
    if (splitEvent instanceof CustomEvent) {
      expect(splitEvent.detail).not.toHaveProperty('ratio')
    }
  })

  it.each(['background', 'focused'] as const)(
    'preserves existing state when a vanished ratio source rejects a %s reveal',
    async (presentation) => {
      const harness = await scenario()
      const remainingLayout: TerminalLayoutSnapshot = {
        root: { type: 'leaf', leafId: SIBLING },
        activeLeafId: SIBLING,
        expandedLeafId: null,
        ptyIdsByLeafId: { [SIBLING]: 'pty-sibling' },
        titlesByLeafId: { [SIBLING]: 'Keep sibling title' }
      }
      harness.storeState.tabsByWorktree['wt-2'] = [
        { id: TAB_ID, ptyId: 'pty-sibling', title: 'Terminal 1' }
      ]
      harness.storeState.ptyIdsByTabId[TAB_ID] = ['pty-sibling']
      harness.storeState.terminalLayoutsByTabId[TAB_ID] = remainingLayout
      const nativeStore = await nativePtyBindings(harness, remainingLayout)
      const bindingCommits: { primaryPtyId: string | null; ptyIds: string[] }[] = []
      const unsubscribe = nativeStore.subscribe((state) => {
        bindingCommits.push({
          primaryPtyId: state.tabsByWorktree['wt-2'][0]?.ptyId ?? null,
          ptyIds: [...(state.ptyIdsByTabId[TAB_ID] ?? [])]
        })
      })
      const before = JSON.parse(
        JSON.stringify({
          tabs: harness.storeState.tabsByWorktree,
          ptys: harness.storeState.ptyIdsByTabId,
          layouts: harness.storeState.terminalLayoutsByTabId,
          lastKnownPtys: nativeStore.getState().lastKnownRelayPtyIdByTabId,
          worktrees: nativeStore.getState().worktreesByRepo
        })
      )

      harness.reveal(0.85, {
        presentation,
        command: 'echo split-startup',
        launchConfig: LAUNCH_CONFIG,
        launchAgent: 'claude'
      })
      unsubscribe()

      expect.soft(bindingCommits, 'native PTY binding commits').toEqual([])
      expect.soft(nativeStore.getState().tabsByWorktree['wt-2'][0]?.ptyId).toBe('pty-sibling')
      expect
        .soft({
          tabs: harness.storeState.tabsByWorktree,
          ptys: harness.storeState.ptyIdsByTabId,
          layouts: harness.storeState.terminalLayoutsByTabId,
          lastKnownPtys: nativeStore.getState().lastKnownRelayPtyIdByTabId,
          worktrees: nativeStore.getState().worktreesByRepo
        })
        .toEqual(before)
      for (const [name, effect] of Object.entries({
        updateTabPtyId: harness.updateTabPtyId,
        setTabLayout: harness.setTabLayout,
        createTab: harness.createTab,
        setActiveView: harness.setActiveView,
        setActiveWorktree: harness.setActiveWorktree,
        markWorktreeVisited: harness.markWorktreeVisited,
        recordWorktreeVisit: harness.recordWorktreeVisit,
        setActiveTabType: harness.setActiveTabType,
        setActiveTab: harness.setActiveTab,
        revealWorktreeInSidebar: harness.revealWorktreeInSidebar,
        focusRuntimeTerminalSurface: harness.focusRuntimeTerminalSurface,
        focusTerminalTabSurface: harness.focusTerminalTabSurface,
        registerAgentLaunchConfig: harness.registerAgentLaunchConfig,
        queueTabStartupCommand: harness.queueTabStartupCommand,
        dispatchEvent: harness.dispatchEvent
      })) {
        expect.soft(effect, name).not.toHaveBeenCalled()
      }
      expect(harness.replyTerminalCreate).toHaveBeenCalledExactlyOnceWith({
        requestId: 'req-ratio',
        error: 'terminal_split_source_not_found'
      })
    }
  )

  it.each([0.85, undefined])(
    'keeps successful focused split effects with ratio %s',
    async (ratio) => {
      const harness = await scenario()
      const nativeStore = await nativePtyBindings(harness, harness.layout)
      harness.reveal(ratio, {
        presentation: 'focused',
        command: 'echo split-startup',
        launchConfig: LAUNCH_CONFIG,
        launchAgent: 'claude'
      })
      expect(harness.storeState.terminalLayoutsByTabId[TAB_ID]).toMatchObject({
        root: { ratio: 0.7, second: { ratio: ratio ?? 0.5 } },
        activeLeafId: NEW_LEAF
      })
      expect(nativeStore.getState().tabsByWorktree['wt-2'][0]?.ptyId).toBe('pty-source')
      expect(nativeStore.getState().ptyIdsByTabId[TAB_ID]).toEqual([
        'pty-source',
        'pty-sibling',
        'pty-new'
      ])
      expect(harness.setActiveWorktree).toHaveBeenCalledExactlyOnceWith('wt-2')
      expect(harness.setActiveTab).toHaveBeenCalledExactlyOnceWith(TAB_ID)
      expect(harness.revealWorktreeInSidebar).toHaveBeenCalledExactlyOnceWith('wt-2')
      expect(harness.registerAgentLaunchConfig).toHaveBeenCalledOnce()
      expect(harness.queueTabStartupCommand).toHaveBeenCalledExactlyOnceWith(TAB_ID, {
        command: 'echo split-startup',
        launchConfig: LAUNCH_CONFIG,
        launchAgent: 'claude'
      })
      expect(harness.replyTerminalCreate).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          requestId: 'req-ratio',
          tabId: TAB_ID,
          identity: expect.any(Object)
        })
      )
    }
  )

  it('retains the legacy omitted-ratio fallback when the source vanished', async () => {
    const harness = await scenario()
    harness.layout.root = { type: 'leaf', leafId: SIBLING }
    harness.reveal(undefined, { presentation: 'focused', command: 'echo split-startup' })
    expect(harness.storeState.terminalLayoutsByTabId[TAB_ID]).toMatchObject({
      root: {
        ratio: 0.5,
        first: { type: 'leaf', leafId: SIBLING },
        second: { type: 'leaf', leafId: NEW_LEAF }
      }
    })
    expect(harness.updateTabPtyId).toHaveBeenCalledExactlyOnceWith(TAB_ID, 'pty-new')
    expect(harness.queueTabStartupCommand).toHaveBeenCalledExactlyOnceWith(TAB_ID, {
      command: 'echo split-startup'
    })
    expect(harness.replyTerminalCreate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        requestId: 'req-ratio',
        tabId: TAB_ID,
        identity: expect.any(Object)
      })
    )
  })
})
