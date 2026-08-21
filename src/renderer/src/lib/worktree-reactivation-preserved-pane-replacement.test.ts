import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore, type AppState } from '@/store'
import { activateAndRevealWorktree } from './worktree-activation'
import { makeCreatedAgentWorktree as makeWorktree } from '@/lib/worktree-activation-created-agent-test-state'
import { makePaneKey } from '../../../shared/stable-pane-id'

// Pins the activation contract behind the run6-review-pr-11959 incident shape:
// a persisted (husk) tab whose pane cannot resume in place gets ONE appended
// replacement tab per provider session — the husk is retained for scrollback —
// while a pane that is live or will cold-restore in place gets NO replacement.

const initialAppStoreState = useAppStore.getState()

const LEAF_ID = '22222222-2222-4222-8222-222222222222'
const HUSK_TAB_ID = 'husk-tab-1'

function baseState(worktree: ReturnType<typeof makeWorktree>): Partial<AppState> {
  return {
    repos: [
      {
        id: 'repo-1',
        path: path.join(path.sep, 'workspace', 'repo'),
        displayName: 'repo',
        badgeColor: '#000000',
        addedAt: 0
      }
    ],
    worktreesByRepo: { 'repo-1': [worktree] },
    activeRepoId: 'repo-1',
    activeView: 'terminal',
    tabsByWorktree: {},
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    layoutByWorktree: {},
    activeGroupIdByWorktree: {},
    openFiles: [],
    browserTabsByWorktree: {},
    activeFileIdByWorktree: {},
    activeBrowserTabIdByWorktree: {},
    activeTabTypeByWorktree: {},
    activeTabIdByWorktree: {},
    tabBarOrderByWorktree: {},
    pendingStartupByTabId: {},
    automaticAgentResumeClaimsByTabId: {},
    agentStatusByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {},
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {},
    settings: {
      agentCmdOverrides: {},
      setupScriptLaunchMode: 'new-tab'
    } as unknown as ReturnType<typeof useAppStore.getState>['settings'],
    markWorktreeVisited: vi.fn(),
    recordWorktreeVisit: vi.fn(),
    refreshGitHubForWorktreeIfStale: vi.fn(),
    revealWorktreeInSidebar: vi.fn()
  }
}

function seedHuskTab(
  state: Partial<AppState>,
  worktreeId: string,
  ptyBinding: string | null
): void {
  state.tabsByWorktree = {
    [worktreeId]: [{ id: HUSK_TAB_ID, title: 'Codex', ptyId: null } as never]
  }
  state.unifiedTabsByWorktree = {
    [worktreeId]: [
      {
        id: `unified-${HUSK_TAB_ID}`,
        contentType: 'terminal',
        entityId: HUSK_TAB_ID,
        groupId: 'group-1'
      } as never
    ]
  }
  state.groupsByWorktree = {
    [worktreeId]: [
      {
        id: 'group-1',
        activeTabId: `unified-${HUSK_TAB_ID}`,
        tabOrder: [`unified-${HUSK_TAB_ID}`],
        recentTabIds: []
      } as never
    ]
  }
  state.activeGroupIdByWorktree = { [worktreeId]: 'group-1' }
  state.terminalLayoutsByTabId = {
    [HUSK_TAB_ID]: {
      root: { type: 'leaf', leafId: LEAF_ID },
      activeLeafId: LEAF_ID,
      ...(ptyBinding ? { ptyIdsByLeafId: { [LEAF_ID]: ptyBinding } } : {})
    } as never
  }
}

function seedSleepingRecord(worktreeId: string, sessionId: string): void {
  const paneKey = makePaneKey(HUSK_TAB_ID, LEAF_ID)
  useAppStore.setState((s) => ({
    sleepingAgentSessionsByPaneKey: {
      ...s.sleepingAgentSessionsByPaneKey,
      [paneKey]: {
        paneKey,
        tabId: HUSK_TAB_ID,
        worktreeId,
        agent: 'codex' as const,
        providerSession: { key: 'session_id' as const, id: sessionId },
        prompt: 'resume prior task',
        state: 'working' as const,
        origin: 'quit' as const,
        capturedAt: 1000,
        updatedAt: 1000,
        terminalTitle: 'Codex'
      }
    }
  }))
}

afterEach(() => {
  useAppStore.setState(initialAppStoreState, true)
})

describe('preserved-pane replacement contract on workspace activation', () => {
  it('appends exactly one replacement tab for a husk pane and retains the husk across repeats', () => {
    const worktree = { ...makeWorktree(), createdWithAgent: undefined }
    const state = baseState(worktree)
    // Hibernation cleared the pane's PTY binding: the husk cannot resume in place.
    seedHuskTab(state, worktree.id, null)
    useAppStore.setState(state)
    seedSleepingRecord(worktree.id, 'codex-session-A')

    activateAndRevealWorktree(worktree.id)

    const afterFirst = useAppStore.getState()
    const tabsAfterFirst = afterFirst.tabsByWorktree[worktree.id] ?? []
    expect(tabsAfterFirst.map((tab) => tab.id)).toContain(HUSK_TAB_ID)
    expect(tabsAfterFirst).toHaveLength(2)
    const replacement = tabsAfterFirst.find((tab) => tab.id !== HUSK_TAB_ID)!
    expect(afterFirst.automaticAgentResumeClaimsByTabId[replacement.id]?.providerSession).toEqual({
      key: 'session_id',
      id: 'codex-session-A'
    })
    expect(afterFirst.consumeTabStartupCommand(replacement.id)?.resumeProviderSession).toEqual({
      key: 'session_id',
      id: 'codex-session-A'
    })

    // Reopening must not fork more tabs or launch another resume.
    activateAndRevealWorktree(worktree.id)
    activateAndRevealWorktree(worktree.id)
    const afterRepeats = useAppStore.getState()
    expect(afterRepeats.tabsByWorktree[worktree.id]).toHaveLength(2)
  })

  it('does not append a replacement while the preserved pane still has a live PTY', () => {
    const worktree = { ...makeWorktree(), createdWithAgent: undefined }
    const state = baseState(worktree)
    seedHuskTab(state, worktree.id, 'pty-live-1')
    state.ptyIdsByTabId = { [HUSK_TAB_ID]: ['pty-live-1'] }
    useAppStore.setState(state)
    seedSleepingRecord(worktree.id, 'codex-session-B')

    activateAndRevealWorktree(worktree.id)

    const after = useAppStore.getState()
    expect(after.tabsByWorktree[worktree.id]).toHaveLength(1)
    // The record stays with its live pane instead of forking a duplicate.
    expect(after.sleepingAgentSessionsByPaneKey[makePaneKey(HUSK_TAB_ID, LEAF_ID)]).toBeDefined()
  })

  it('does not fork a NON-group-active restorable pane into a replacement tab', () => {
    const worktree = { ...makeWorktree(), createdWithAgent: undefined }
    const state = baseState(worktree)
    seedHuskTab(state, worktree.id, 'pty-old-1')
    // A second tab holds the group-active slot; the husk is hidden but will
    // still mount keep-alive and cold-restore in place on activation.
    state.tabsByWorktree = {
      [worktree.id]: [
        { id: HUSK_TAB_ID, title: 'Codex', ptyId: null } as never,
        { id: 'other-tab-1', title: 'shell', ptyId: null } as never
      ]
    }
    state.unifiedTabsByWorktree = {
      [worktree.id]: [
        {
          id: `unified-${HUSK_TAB_ID}`,
          contentType: 'terminal',
          entityId: HUSK_TAB_ID,
          groupId: 'group-1'
        } as never,
        {
          id: 'unified-other-tab-1',
          contentType: 'terminal',
          entityId: 'other-tab-1',
          groupId: 'group-1'
        } as never
      ]
    }
    state.groupsByWorktree = {
      [worktree.id]: [
        {
          id: 'group-1',
          activeTabId: 'unified-other-tab-1',
          tabOrder: [`unified-${HUSK_TAB_ID}`, 'unified-other-tab-1'],
          recentTabIds: []
        } as never
      ]
    }
    state.activeTabIdByWorktree = { [worktree.id]: 'other-tab-1' }
    state.activeTabTypeByWorktree = { [worktree.id]: 'terminal' }
    useAppStore.setState(state)
    seedSleepingRecord(worktree.id, 'codex-session-D')

    activateAndRevealWorktree(worktree.id)
    activateAndRevealWorktree(worktree.id)

    const after = useAppStore.getState()
    expect(after.tabsByWorktree[worktree.id]?.map((tab) => tab.id)).toEqual([
      HUSK_TAB_ID,
      'other-tab-1'
    ])
    // The record stays with the pane that will cold-restore in place —
    // consuming it here would resume the session twice (pane + replacement).
    expect(after.sleepingAgentSessionsByPaneKey[makePaneKey(HUSK_TAB_ID, LEAF_ID)]).toBeDefined()
  })

  it('does not append a replacement when the preserved pane will cold-restore in place', () => {
    const worktree = { ...makeWorktree(), createdWithAgent: undefined }
    const state = baseState(worktree)
    // Restorable binding persists, no live PTY: pane-level cold restore owns recovery.
    seedHuskTab(state, worktree.id, 'pty-old-1')
    state.activeTabIdByWorktree = { [worktree.id]: HUSK_TAB_ID }
    state.activeTabTypeByWorktree = { [worktree.id]: 'terminal' }
    useAppStore.setState(state)
    seedSleepingRecord(worktree.id, 'codex-session-C')

    activateAndRevealWorktree(worktree.id)

    const after = useAppStore.getState()
    expect(after.tabsByWorktree[worktree.id]).toHaveLength(1)
    expect(after.sleepingAgentSessionsByPaneKey[makePaneKey(HUSK_TAB_ID, LEAF_ID)]).toBeDefined()
  })

  // Why: web-mirror tabs never mount a local pane, so they cannot own recovery
  // — the appended replacement stays the correct resume path for them.
  it('still appends a replacement for a web-mirror tab that cannot mount a local pane', () => {
    const webTabId = 'web-terminal-host-tab'
    const worktree = { ...makeWorktree(), createdWithAgent: undefined }
    const state = baseState(worktree)
    state.tabsByWorktree = {
      [worktree.id]: [{ id: webTabId, title: 'Codex', ptyId: null } as never]
    }
    state.unifiedTabsByWorktree = {
      [worktree.id]: [
        {
          id: `unified-${webTabId}`,
          contentType: 'terminal',
          entityId: webTabId,
          groupId: 'group-1'
        } as never
      ]
    }
    state.groupsByWorktree = {
      [worktree.id]: [
        {
          id: 'group-1',
          activeTabId: `unified-${webTabId}`,
          tabOrder: [`unified-${webTabId}`],
          recentTabIds: []
        } as never
      ]
    }
    state.activeGroupIdByWorktree = { [worktree.id]: 'group-1' }
    state.terminalLayoutsByTabId = {
      [webTabId]: {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        ptyIdsByLeafId: { [LEAF_ID]: 'pty-old-1' }
      } as never
    }
    useAppStore.setState(state)
    const paneKey = makePaneKey(webTabId, LEAF_ID)
    useAppStore.setState((s) => ({
      sleepingAgentSessionsByPaneKey: {
        ...s.sleepingAgentSessionsByPaneKey,
        [paneKey]: {
          paneKey,
          tabId: webTabId,
          worktreeId: worktree.id,
          agent: 'codex' as const,
          providerSession: { key: 'session_id' as const, id: 'codex-session-E' },
          prompt: 'resume prior task',
          state: 'working' as const,
          origin: 'quit' as const,
          capturedAt: 1000,
          updatedAt: 1000,
          terminalTitle: 'Codex'
        }
      }
    }))

    activateAndRevealWorktree(worktree.id)

    const after = useAppStore.getState()
    const tabs = after.tabsByWorktree[worktree.id] ?? []
    expect(tabs.map((tab) => tab.id)).toContain(webTabId)
    expect(tabs).toHaveLength(2)
    expect(after.sleepingAgentSessionsByPaneKey[paneKey]).toBeUndefined()
    const replacement = tabs.find((tab) => tab.id !== webTabId)!
    expect(after.automaticAgentResumeClaimsByTabId[replacement.id]?.providerSession).toEqual({
      key: 'session_id',
      id: 'codex-session-E'
    })
    expect(after.consumeTabStartupCommand(replacement.id)?.resumeProviderSession).toEqual({
      key: 'session_id',
      id: 'codex-session-E'
    })
  })
})
