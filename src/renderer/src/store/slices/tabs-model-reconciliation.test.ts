import { describe, it, expect, vi, beforeEach } from 'vitest'
import type * as AgentStatusModule from '@/lib/agent-status'
import { createTabsSliceMockApi } from './tabs-slice-test-harness'
import { createTestStore } from './store-test-helpers'

// Mock sonner (imported by repos.ts)
vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

// Mock agent-status (imported by terminal-helpers)
vi.mock('@/lib/agent-status', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentStatusModule>()
  return {
    ...actual,
    detectAgentStatusFromTitle: vi.fn().mockReturnValue(null)
  }
})

createTabsSliceMockApi()

const WT = 'repo1::/tmp/feature'

describe('TabsSlice', () => {
  let store: ReturnType<typeof createTestStore>

  beforeEach(() => {
    store = createTestStore()
  })

  describe('reconcileWorktreeTabModel', () => {
    it('drops unified tabs whose backing content no longer exists', () => {
      const groupId = 'g-1'
      store.setState({
        unifiedTabsByWorktree: {
          [WT]: [
            {
              id: 'stale-terminal',
              entityId: 'stale-terminal',
              groupId,
              worktreeId: WT,
              contentType: 'terminal',
              label: 'Terminal 1',
              customLabel: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        groupsByWorktree: {
          [WT]: [
            {
              id: groupId,
              worktreeId: WT,
              activeTabId: 'stale-terminal',
              tabOrder: ['stale-terminal']
            }
          ]
        },
        activeGroupIdByWorktree: { [WT]: groupId },
        tabsByWorktree: { [WT]: [] }
      })

      const result = store.getState().reconcileWorktreeTabModel(WT)

      expect(result.renderableTabCount).toBe(0)
      expect(result.activeRenderableTabId).toBeNull()
      expect(store.getState().unifiedTabsByWorktree[WT]).toEqual([])
      expect(store.getState().groupsByWorktree[WT][0].tabOrder).toEqual([])
      expect(store.getState().groupsByWorktree[WT][0].activeTabId).toBeNull()
    })

    // Regression for #9911: a reconnecting terminal (ptyId/ptyIdsByTabId cleared
    // on SSH-relay drop or hydration, live session held in a reconnect map) whose
    // unified entry is transiently absent must not be hard-deleted by the orphan
    // sweep before reconnect rebinds it.
    it('keeps a reconnecting terminal whose live session survives only in a reconnect map', () => {
      store.setState({
        tabsByWorktree: {
          [WT]: [
            {
              id: 'reconnecting-terminal',
              ptyId: null,
              worktreeId: WT,
              title: 'claude',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        ptyIdsByTabId: { 'reconnecting-terminal': [] },
        pendingReconnectPtyIdByTabId: { 'reconnecting-terminal': 'session-live' },
        unifiedTabsByWorktree: { [WT]: [] },
        groupsByWorktree: {},
        activeGroupIdByWorktree: {}
      })

      const result = store.getState().reconcileWorktreeTabModel(WT)
      const state = store.getState()

      // The live tab survives the sweep…
      expect(state.tabsByWorktree[WT].map((tab) => tab.id)).toContain('reconnecting-terminal')
      // …and is re-migrated into the unified model so it renders and can reattach.
      expect(state.unifiedTabsByWorktree[WT].map((tab) => tab.entityId)).toContain(
        'reconnecting-terminal'
      )
      expect(result.renderableTabCount).toBe(1)
    })

    it('keeps simulator tabs because they reconnect their own backing stream', () => {
      const terminalGroupId = 'g-terminal'
      const simulatorGroupId = 'g-simulator'
      store.setState({
        unifiedTabsByWorktree: {
          [WT]: [
            {
              id: 'terminal-1',
              entityId: 'terminal-1',
              groupId: terminalGroupId,
              worktreeId: WT,
              contentType: 'terminal',
              label: 'Terminal 1',
              customLabel: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            },
            {
              id: 'simulator-1',
              entityId: 'simulator-1',
              groupId: simulatorGroupId,
              worktreeId: WT,
              contentType: 'simulator',
              label: 'iPhone 17 Pro',
              customLabel: null,
              color: null,
              sortOrder: 0,
              createdAt: 2
            }
          ]
        },
        groupsByWorktree: {
          [WT]: [
            {
              id: terminalGroupId,
              worktreeId: WT,
              activeTabId: 'terminal-1',
              tabOrder: ['terminal-1']
            },
            {
              id: simulatorGroupId,
              worktreeId: WT,
              activeTabId: 'simulator-1',
              tabOrder: ['simulator-1']
            }
          ]
        },
        layoutByWorktree: {
          [WT]: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', groupId: terminalGroupId },
            second: { type: 'leaf', groupId: simulatorGroupId }
          }
        },
        activeGroupIdByWorktree: { [WT]: simulatorGroupId },
        tabsByWorktree: {
          [WT]: [
            {
              id: 'terminal-1',
              ptyId: 'pty-1',
              worktreeId: WT,
              title: 'Terminal 1',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        ptyIdsByTabId: { 'terminal-1': ['pty-1'] }
      })

      const result = store.getState().reconcileWorktreeTabModel(WT)
      const state = store.getState()

      expect(result.renderableTabCount).toBe(2)
      expect(result.activeRenderableTabId).toBe('simulator-1')
      expect(state.unifiedTabsByWorktree[WT].map((tab) => tab.id)).toEqual([
        'terminal-1',
        'simulator-1'
      ])
      expect(state.groupsByWorktree[WT].map((group) => group.tabOrder)).toEqual([
        ['terminal-1'],
        ['simulator-1']
      ])
      expect(state.layoutByWorktree[WT]).toEqual({
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', groupId: terminalGroupId },
        second: { type: 'leaf', groupId: simulatorGroupId }
      })
    })

    it('collapses empty split groups when reconciliation drops a stale tab', () => {
      const terminalGroupId = 'g-terminal'
      const staleGroupId = 'g-stale'
      store.setState({
        unifiedTabsByWorktree: {
          [WT]: [
            {
              id: 'terminal-1',
              entityId: 'terminal-1',
              groupId: terminalGroupId,
              worktreeId: WT,
              contentType: 'terminal',
              label: 'Terminal 1',
              customLabel: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            },
            {
              id: 'stale-browser',
              entityId: 'missing-browser',
              groupId: staleGroupId,
              worktreeId: WT,
              contentType: 'browser',
              label: 'Missing browser',
              customLabel: null,
              color: null,
              sortOrder: 1,
              createdAt: 2
            }
          ]
        },
        groupsByWorktree: {
          [WT]: [
            {
              id: terminalGroupId,
              worktreeId: WT,
              activeTabId: 'terminal-1',
              tabOrder: ['terminal-1']
            },
            {
              id: staleGroupId,
              worktreeId: WT,
              activeTabId: 'stale-browser',
              tabOrder: ['stale-browser']
            }
          ]
        },
        layoutByWorktree: {
          [WT]: {
            type: 'split',
            direction: 'horizontal',
            first: { type: 'leaf', groupId: terminalGroupId },
            second: { type: 'leaf', groupId: staleGroupId }
          }
        },
        activeGroupIdByWorktree: { [WT]: staleGroupId },
        tabsByWorktree: {
          [WT]: [
            {
              id: 'terminal-1',
              ptyId: 'pty-1',
              worktreeId: WT,
              title: 'Terminal 1',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        ptyIdsByTabId: { 'terminal-1': ['pty-1'] },
        browserTabsByWorktree: { [WT]: [] }
      })

      const result = store.getState().reconcileWorktreeTabModel(WT)
      const state = store.getState()

      expect(result.renderableTabCount).toBe(1)
      expect(result.activeRenderableTabId).toBe('terminal-1')
      expect(state.groupsByWorktree[WT]).toEqual([
        expect.objectContaining({ id: terminalGroupId, tabOrder: ['terminal-1'] })
      ])
      expect(state.layoutByWorktree[WT]).toEqual({ type: 'leaf', groupId: terminalGroupId })
      expect(state.activeGroupIdByWorktree[WT]).toBe(terminalGroupId)
    })

    it('restores live runtime terminal tabs into the unified tab model', () => {
      const runtimeTerminalId = 'runtime-terminal-1'

      store.setState({
        tabsByWorktree: {
          [WT]: [
            {
              id: runtimeTerminalId,
              ptyId: 'pty-4',
              worktreeId: WT,
              title: 'Terminal 1',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        },
        ptyIdsByTabId: {
          [runtimeTerminalId]: ['pty-4']
        },
        unifiedTabsByWorktree: {
          [WT]: []
        },
        groupsByWorktree: {
          [WT]: []
        },
        activeGroupIdByWorktree: {}
      })

      const result = store.getState().reconcileWorktreeTabModel(WT)
      const state = store.getState()
      const restoredTab = state.unifiedTabsByWorktree[WT]?.[0]
      const restoredGroup = state.groupsByWorktree[WT]?.[0]

      expect(result.renderableTabCount).toBe(1)
      expect(result.activeRenderableTabId).toBe(runtimeTerminalId)
      expect(restoredTab).toMatchObject({
        id: runtimeTerminalId,
        entityId: runtimeTerminalId,
        contentType: 'terminal',
        label: 'Terminal 1'
      })
      expect(restoredGroup).toMatchObject({
        activeTabId: runtimeTerminalId,
        tabOrder: [runtimeTerminalId]
      })
      expect(state.layoutByWorktree[WT]).toEqual({
        type: 'leaf',
        groupId: restoredGroup?.id
      })
    })

    it('promotes legacy terminals to the worktree remembered tab, not always the first one', () => {
      // Why (regression): reconcile seeded the group with restoredLegacyTabs[0], dropping the remembered selection so it always reopened Terminal 1.
      const firstTerminalId = 'runtime-terminal-1'
      const secondTerminalId = 'runtime-terminal-2'

      store.setState({
        tabsByWorktree: {
          [WT]: [
            {
              id: firstTerminalId,
              ptyId: 'pty-1',
              worktreeId: WT,
              title: 'Terminal 1',
              customTitle: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            },
            {
              id: secondTerminalId,
              ptyId: 'pty-2',
              worktreeId: WT,
              title: 'Terminal 2',
              customTitle: null,
              color: null,
              sortOrder: 1,
              createdAt: 2
            }
          ]
        },
        ptyIdsByTabId: {
          [firstTerminalId]: ['pty-1'],
          [secondTerminalId]: ['pty-2']
        },
        unifiedTabsByWorktree: { [WT]: [] },
        groupsByWorktree: { [WT]: [] },
        activeGroupIdByWorktree: {},
        // The user had Terminal 2 active before leaving this worktree.
        activeTabIdByWorktree: { [WT]: secondTerminalId }
      })

      const result = store.getState().reconcileWorktreeTabModel(WT)
      const restoredGroup = store.getState().groupsByWorktree[WT]?.[0]

      expect(result.renderableTabCount).toBe(2)
      expect(result.activeRenderableTabId).toBe(secondTerminalId)
      expect(restoredGroup?.activeTabId).toBe(secondTerminalId)
    })

    it('keeps a sole terminal renderable after its PTY exits so a failed direnv does not strand the worktree', () => {
      // Why (regression): a promoted terminal whose PTY dies must stay renderable, not orphan and bounce to Landing.
      const tab = store
        .getState()
        .createTab(WT, undefined, undefined, { pendingActivationSpawn: true })
      store.getState().updateTabPtyId(tab.id, 'pty-died')
      // First reconcile promotes the legacy runtime tab into the unified model.
      expect(store.getState().reconcileWorktreeTabModel(WT).renderableTabCount).toBe(1)

      // The newborn PTY exits: pty-connection clears the binding but keeps the pane.
      store.getState().clearTabPtyId(tab.id, 'pty-died')
      const clearedTab = store.getState().tabsByWorktree[WT]?.find((t) => t.id === tab.id)
      expect(store.getState().ptyIdsByTabId[tab.id] ?? []).toEqual([])
      expect(clearedTab?.ptyId ?? null).toBeNull()

      const result = store.getState().reconcileWorktreeTabModel(WT)
      expect(result.renderableTabCount).toBe(1)
      expect(result.activeRenderableTabId).toBe(tab.id)
    })
  })
})
