import './terminal-hydration-store-test-bootstrap'
import { describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import { buildWorkspaceSessionPayload } from '@/lib/workspace-session'
import { createTestStore, makeLayout, makeTab, makeWorktree, seedStore } from './store-test-helpers'

describe('hydrateWorkspaceSession canonical terminal rows', () => {
  it('drops only legacy rows that duplicate canonical PTY ownership', () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/wt-1'
    const sharedPtyId = 'daemon-session-1'
    const recoveryPtyId = 'daemon-session-2'
    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: worktreeId, repoId: 'repo1', path: '/wt-1' })]
      }
    })

    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      activeRepoId: 'repo1',
      activeWorktreeId: worktreeId,
      activeTabId: 'stale-tab',
      activeWorktreeIdsOnShutdown: [worktreeId],
      activeTabIdByWorktree: { [worktreeId]: 'stale-tab' },
      tabsByWorktree: {
        [worktreeId]: [
          makeTab({ id: 'canonical-tab', worktreeId, ptyId: sharedPtyId }),
          makeTab({ id: 'stale-tab', worktreeId, ptyId: sharedPtyId }),
          makeTab({ id: 'recovery-tab', worktreeId, ptyId: recoveryPtyId })
        ]
      },
      terminalLayoutsByTabId: {
        'canonical-tab': {
          ...makeLayout(),
          ptyIdsByLeafId: { 'canonical-leaf': sharedPtyId }
        },
        'stale-tab': {
          ...makeLayout(),
          ptyIdsByLeafId: { 'stale-leaf': sharedPtyId }
        },
        'recovery-tab': {
          ...makeLayout(),
          ptyIdsByLeafId: { 'recovery-leaf': recoveryPtyId }
        }
      },
      remoteSessionIdsByTabId: {
        'canonical-tab': sharedPtyId,
        'stale-tab': sharedPtyId,
        'recovery-tab': recoveryPtyId
      },
      unifiedTabs: {
        [worktreeId]: [
          {
            id: 'canonical-unified-tab',
            entityId: 'canonical-tab',
            groupId: 'group-1',
            worktreeId,
            contentType: 'terminal',
            label: 'Grok',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      tabGroups: {
        [worktreeId]: [
          {
            id: 'group-1',
            worktreeId,
            activeTabId: 'canonical-unified-tab',
            tabOrder: ['canonical-unified-tab']
          }
        ]
      }
    }

    store.getState().hydrateWorkspaceSession(session)
    store.getState().hydrateTabsSession(session)
    const reconciliation = store.getState().reconcileWorktreeTabModel(worktreeId)
    const state = store.getState()
    const persisted = buildWorkspaceSessionPayload(state)

    expect(reconciliation.renderableTabCount).toBe(2)
    expect(state.unifiedTabsByWorktree[worktreeId]?.map((tab) => tab.entityId)).toEqual([
      'canonical-tab',
      'recovery-tab'
    ])
    expect(state.tabsByWorktree[worktreeId]?.map((tab) => tab.id)).toEqual([
      'canonical-tab',
      'recovery-tab'
    ])
    expect(state.terminalLayoutsByTabId['stale-tab']).toBeUndefined()
    expect(persisted.tabsByWorktree[worktreeId]?.map((tab) => tab.id)).toEqual([
      'canonical-tab',
      'recovery-tab'
    ])
    expect(persisted.terminalLayoutsByTabId['stale-tab']).toBeUndefined()
    expect(state.pendingReconnectTabByWorktree[worktreeId]).toEqual([
      'canonical-tab',
      'recovery-tab'
    ])
    expect(state.pendingReconnectPtyIdByTabId).toEqual({
      'canonical-tab': sharedPtyId,
      'recovery-tab': recoveryPtyId
    })
    // The canonical row inherited the dropped row's PTY, so focus follows it instead of resetting.
    expect(state.activeTabId).toBe('canonical-tab')
    expect(state.activeTabIdByWorktree).toEqual({ [worktreeId]: 'canonical-tab' })
  })

  it('clears sleeping-agent records for subsumed and invalid-id rows only', () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/wt-1'
    const sharedPtyId = 'daemon-session-1'
    const recoveryPtyId = 'daemon-session-2'
    const invalidTabId = 'host-tab::11111111-1111-4111-8111-111111111111'
    const leafId = '22222222-2222-4222-8222-222222222222'
    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: worktreeId, repoId: 'repo1', path: '/wt-1' })]
      }
    })
    const makeSleepingRecord = (tabId: string): SleepingAgentSessionRecord => ({
      paneKey: `${tabId}:${leafId}`,
      tabId,
      worktreeId,
      agent: 'codex',
      providerSession: { key: 'session_id', id: `session-${tabId}` },
      prompt: 'continue',
      state: 'working',
      capturedAt: 1,
      updatedAt: 1
    })

    const session: WorkspaceSessionState = {
      ...getDefaultWorkspaceSession(),
      activeRepoId: 'repo1',
      activeWorktreeId: worktreeId,
      activeWorktreeIdsOnShutdown: [worktreeId],
      tabsByWorktree: {
        [worktreeId]: [
          makeTab({ id: 'canonical-tab', worktreeId, ptyId: sharedPtyId }),
          makeTab({ id: 'stale-tab', worktreeId, ptyId: sharedPtyId }),
          makeTab({ id: invalidTabId, worktreeId, ptyId: null }),
          makeTab({ id: 'recovery-tab', worktreeId, ptyId: recoveryPtyId })
        ]
      },
      terminalLayoutsByTabId: {
        'canonical-tab': { ...makeLayout(), ptyIdsByLeafId: { 'canonical-leaf': sharedPtyId } },
        'stale-tab': { ...makeLayout(), ptyIdsByLeafId: { 'stale-leaf': sharedPtyId } },
        'recovery-tab': { ...makeLayout(), ptyIdsByLeafId: { 'recovery-leaf': recoveryPtyId } }
      },
      sleepingAgentSessionsByPaneKey: {
        [`stale-tab:${leafId}`]: makeSleepingRecord('stale-tab'),
        [`${invalidTabId}:${leafId}`]: makeSleepingRecord(invalidTabId),
        [`recovery-tab:${leafId}`]: makeSleepingRecord('recovery-tab')
      },
      unifiedTabs: {
        [worktreeId]: [
          {
            id: 'canonical-unified-tab',
            entityId: 'canonical-tab',
            groupId: 'group-1',
            worktreeId,
            contentType: 'terminal',
            label: 'Grok',
            customLabel: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      tabGroups: {
        [worktreeId]: [
          {
            id: 'group-1',
            worktreeId,
            activeTabId: 'canonical-unified-tab',
            tabOrder: ['canonical-unified-tab']
          }
        ]
      }
    }

    store.getState().hydrateWorkspaceSession(session)
    const state = store.getState()

    expect(state.tabsByWorktree[worktreeId]?.map((tab) => tab.id)).toEqual([
      'canonical-tab',
      'recovery-tab'
    ])
    // Why: both dropped classes keep a valid worktreeId, so only the per-tab sweep can evict them.
    expect(Object.keys(state.sleepingAgentSessionsByPaneKey)).toEqual([`recovery-tab:${leafId}`])
  })

  it('drops stale unverified-loss markers when full hydration removes their rows', () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/wt-1'
    const retainedTab = makeTab({ id: 'retained-tab', worktreeId, ptyId: null })
    seedStore(store, {
      worktreesByRepo: {
        repo1: [makeWorktree({ id: worktreeId, repoId: 'repo1', path: '/wt-1' })]
      },
      tabsByWorktree: { [worktreeId]: [retainedTab] },
      unverifiedPtyLossTabIds: {
        [retainedTab.id]: true,
        'dropped-tab': true
      }
    })

    store.getState().hydrateWorkspaceSession({
      ...getDefaultWorkspaceSession(),
      activeRepoId: 'repo1',
      activeWorktreeId: worktreeId,
      activeTabId: retainedTab.id,
      tabsByWorktree: { [worktreeId]: [retainedTab] },
      terminalLayoutsByTabId: {}
    })

    expect(store.getState().unverifiedPtyLossTabIds).toEqual({
      [retainedTab.id]: true
    })
  })
})
