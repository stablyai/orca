import { describe, expect, it, vi } from 'vitest'
import { ORCA_LAYOUT_OWNER_IS_MAIN } from '../../../shared/layout-owner-switch'
import { structuredAgentSessionTabId } from '../../../shared/structured-agent-session-projection'
import type { PtyListedSession } from '../../../shared/pty-listed-session'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import { runWorktreeAgentActivationGate } from './worktree-agent-activation-gate'
import {
  DEAD_LEAF_ID,
  type GateTestStore,
  listed,
  LIVE_LEAF_ID,
  seedExistingSurface,
  SIBLING_LEAF_ID,
  sleepingRecord,
  testDeps,
  UNOWNED,
  WORKTREE_ID
} from './worktree-agent-activation-gate.test-fixture'
import { indexLiveTerminalSurfaceOwners } from './worktree-live-terminal-surface-owners'

// Main places live terminals in a layout-owner build; those tests' twins are in
// worktree-agent-activation-gate-layout-owner.test.ts, under the same name unless noted.
const windowOwnedIt = it.skipIf(ORCA_LAYOUT_OWNER_IS_MAIN)

/** Layout-owner build: the sweep only reads main's listing; it binds no pane of its own. */
function expectNoBindingWrite(store: GateTestStore): void {
  expect(store.setTabLayout).not.toHaveBeenCalled()
  expect(store.updateTabPtyId).not.toHaveBeenCalled()
  expect(store.replaceTerminalLayoutPanePtyId).not.toHaveBeenCalled()
}
const STALE_STRUCTURED_SESSION_ID = 'structured-session-stale'

function runtimeSnapshot(
  tabId: string,
  leafId: string,
  ptyIds: string[]
): RuntimeMobileSessionTabsResult {
  return {
    worktree: WORKTREE_ID,
    publicationEpoch: 'packaged-run-31759132745',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: null,
    tabs: [
      ...ptyIds.map((ptyId, index) => ({
        type: 'terminal' as const,
        id: `${tabId}:${leafId}:${index}`,
        title: 'Codex',
        parentTabId: tabId,
        leafId,
        ptyId,
        status: 'ready' as const,
        terminal: `term-${index}`,
        isActive: false
      })),
      {
        type: 'agent-session' as const,
        id: 'structured-agent-session-live-session',
        title: 'Codex Chat',
        sessionId: 'live-session',
        agent: 'codex' as const,
        isActive: false
      }
    ]
  }
}

describe('worktree agent activation gate', () => {
  windowOwnedIt('uses immediately ready development restore inventory', async () => {
    const ptyId = `${WORKTREE_ID}@@live-pty`
    const { deps, createTab, resume } = testDeps({
      sessions: [listed(ptyId)],
      surfaceOwners: new Map([[ptyId, UNOWNED]])
    })
    const awaitReady = vi.fn(async () => true)

    await expect(
      runWorktreeAgentActivationGate(WORKTREE_ID, { ...deps, awaitReady })
    ).resolves.toBe('adopted')

    expect(awaitReady).toHaveBeenCalledOnce()
    expect(createTab).toHaveBeenCalledOnce()
    expect(resume).not.toHaveBeenCalled()
  })

  windowOwnedIt(
    'waits for packaged restore hydration before reading daemon inventory',
    async () => {
      const ptyId = `${WORKTREE_ID}@@live-pty`
      const { deps, createTab, resume } = testDeps({
        sessions: [listed(ptyId)],
        surfaceOwners: new Map([[ptyId, UNOWNED]])
      })
      let releaseReady!: (ready: boolean) => void
      const awaitReady = vi.fn(() => new Promise<boolean>((resolve) => (releaseReady = resolve)))

      const activation = runWorktreeAgentActivationGate(WORKTREE_ID, { ...deps, awaitReady })
      await vi.waitFor(() => expect(awaitReady).toHaveBeenCalledOnce())
      expect(deps.listSessions).not.toHaveBeenCalled()

      releaseReady(true)
      await expect(activation).resolves.toBe('adopted')
      expect(deps.listSessions).toHaveBeenCalledOnce()
      expect(createTab).toHaveBeenCalledOnce()
      expect(resume).not.toHaveBeenCalled()
    }
  )

  it('reads structured ownership before adopting daemon PTYs', async () => {
    const ptyId = `${WORKTREE_ID}@@live-pty`
    const { deps } = testDeps({ sessions: [listed(ptyId)] })
    const hasStructuredSession = vi.fn(async () => false)

    await runWorktreeAgentActivationGate(WORKTREE_ID, { ...deps, hasStructuredSession })

    expect(hasStructuredSession.mock.invocationCallOrder[0]).toBeLessThan(
      deps.listSessions.mock.invocationCallOrder[0] ?? Infinity
    )
  })

  it('blocks seeding while the queried snapshot names a live launch', async () => {
    const { deps, resume } = testDeps({})
    const snapshot = {
      ...runtimeSnapshot('tab', LIVE_LEAF_ID, []),
      tabs: [],
      initialSurfaceLaunch: { launchId: 'launch-1', agent: 'claude' as const }
    }
    await expect(
      runWorktreeAgentActivationGate(WORKTREE_ID, {
        ...deps,
        hasStructuredSession: async () => ({ snapshot, ownerBySessionId: new Map() })
      })
    ).resolves.toBe('blocked')
    expect(deps.listSessions).not.toHaveBeenCalled()
    expect(resume).not.toHaveBeenCalled()
  })

  it('blocks automatic resume when packaged restore never becomes ready', async () => {
    const { deps, createTab, resume } = testDeps({})

    await expect(
      runWorktreeAgentActivationGate(WORKTREE_ID, {
        ...deps,
        awaitReady: async () => false
      })
    ).resolves.toBe('blocked')

    expect(deps.listSessions).not.toHaveBeenCalled()
    expect(createTab).not.toHaveBeenCalled()
    expect(resume).not.toHaveBeenCalled()
  })

  // Layout-owner build: 'adopts the live daemon PTY main placed before activation can resume another agent'.
  windowOwnedIt('adopts a live daemon PTY before activation can resume another agent', async () => {
    const ptyId = `${WORKTREE_ID}@@live-pty`
    const { deps, createTab, resume } = testDeps({
      sessions: [listed(ptyId)],
      surfaceOwners: new Map([[ptyId, UNOWNED]])
    })

    await expect(runWorktreeAgentActivationGate(WORKTREE_ID, deps)).resolves.toBe('adopted')

    expect(createTab).toHaveBeenCalledWith(WORKTREE_ID, undefined, undefined, {
      initialPtyId: ptyId,
      activate: false,
      recordInteraction: false
    })
    expect(resume).not.toHaveBeenCalled()
  })

  // Layout-owner build: 'never surfaces a PTY its host is killing'.
  windowOwnedIt('never gives a surface to a PTY its host is killing', async () => {
    // A pane closed just before quit is still dying when the relaunched app lists it.
    const closingPtyId = `${WORKTREE_ID}@@closed-pane`
    const livePtyId = `${WORKTREE_ID}@@kept-pane`
    const { deps, createTab } = testDeps({
      sessions: [
        { ...listed(closingPtyId), title: 'zsh', agentOwnership: 'absent', exiting: true },
        { ...listed(livePtyId), title: 'zsh', agentOwnership: 'absent' }
      ],
      surfaceOwners: new Map([
        [closingPtyId, UNOWNED],
        [livePtyId, UNOWNED]
      ])
    })

    await runWorktreeAgentActivationGate(WORKTREE_ID, deps)

    expect(createTab).toHaveBeenCalledOnce()
    expect(createTab).toHaveBeenCalledWith(WORKTREE_ID, undefined, undefined, {
      initialPtyId: livePtyId,
      activate: false,
      recordInteraction: false
    })
  })

  // Layout-owner build: 'leaves an unowned PTY to the recorded pane this renderer still holds, bound by main'.
  windowOwnedIt(
    'rebinds an unowned PTY to the recorded pane this renderer still holds',
    async () => {
      const ptyId = `${WORKTREE_ID}@@live-pty`
      const recorded = { paneKey: `tab-live:${LIVE_LEAF_ID}`, ptyId, tabId: 'tab-live' }
      const { deps, createTab, resume } = testDeps({
        sessions: [listed(ptyId)],
        surfaceOwners: new Map([[ptyId, { unowned: true, recorded }]])
      })
      seedExistingSurface(deps.getState(), { tabId: 'tab-live', leafId: LIVE_LEAF_ID })

      await expect(runWorktreeAgentActivationGate(WORKTREE_ID, deps)).resolves.toBe('adopted')

      // The host's graph omits unmounted panes; minting here forked the agent onto a second tab.
      expect(createTab).not.toHaveBeenCalled()
      expect(deps.getState().terminalLayoutsByTabId['tab-live']?.ptyIdsByLeafId).toEqual({
        [LIVE_LEAF_ID]: ptyId
      })
      expect(deps.getState().ptyIdsByTabId['tab-live']).toEqual([ptyId])
      expect(resume).not.toHaveBeenCalled()
    }
  )

  // Layout-owner build: 'shows main’s new tab for an unowned PTY when %s'.
  windowOwnedIt.each<[string, (store: GateTestStore) => void]>([
    [
      'the recorded pane now holds another PTY',
      (store) =>
        seedExistingSurface(store, {
          tabId: 'tab-live',
          leafId: LIVE_LEAF_ID,
          boundPtyId: `${WORKTREE_ID}@@other-pty`
        })
    ],
    ['the recorded tab is gone', () => {}],
    // A closed split or a replaced layout leaves the record naming a leaf the tab no longer has.
    [
      'the recorded leaf is no longer in the tab layout',
      (store) => seedExistingSurface(store, { tabId: 'tab-live', leafId: SIBLING_LEAF_ID })
    ],
    [
      'the recorded tab belongs to another worktree',
      (store) =>
        seedExistingSurface(store, {
          tabId: 'tab-live',
          leafId: LIVE_LEAF_ID,
          worktreeId: 'repo::/other-worktree'
        })
    ]
  ])('mints a tab for an unowned PTY when %s', async (_case, seed) => {
    const ptyId = `${WORKTREE_ID}@@live-pty`
    const recorded = { paneKey: `tab-live:${LIVE_LEAF_ID}`, ptyId, tabId: 'tab-live' }
    const { deps, createTab } = testDeps({
      sessions: [listed(ptyId)],
      surfaceOwners: new Map([[ptyId, { unowned: true, recorded }]])
    })
    seed(deps.getState())
    const recordedLayoutBefore = structuredClone(deps.getState().terminalLayoutsByTabId['tab-live'])

    await expect(runWorktreeAgentActivationGate(WORKTREE_ID, deps)).resolves.toBe('adopted')

    expect(createTab).toHaveBeenCalledWith(WORKTREE_ID, undefined, undefined, {
      initialPtyId: ptyId,
      activate: false,
      recordInteraction: false
    })
    // Nothing may be bound to the recorded surface the gate refused.
    expect(deps.getState().terminalLayoutsByTabId['tab-live']).toEqual(recordedLayoutBefore)
    expect(deps.getState().ptyIdsByTabId['tab-live']).toBeUndefined()
  })

  // Layout-owner build: 'adopts a daemon PTY main placed for a folder workspace'.
  windowOwnedIt('adopts a daemon PTY minted for a folder workspace', async () => {
    const folderWorkspaceId = 'folder:plain-workspace'
    const ptyId = `${folderWorkspaceId}@@live-pty`
    const { deps, createTab, resume } = testDeps({
      sessions: [listed(ptyId)],
      surfaceOwners: new Map([[ptyId, UNOWNED]])
    })

    await expect(runWorktreeAgentActivationGate(folderWorkspaceId, deps)).resolves.toBe('adopted')

    expect(createTab).toHaveBeenCalledWith(folderWorkspaceId, undefined, undefined, {
      initialPtyId: ptyId,
      activate: false,
      recordInteraction: false
    })
    expect(resume).not.toHaveBeenCalled()
  })

  it('does not resume when the workspace has only a structured session', async () => {
    const { deps, createTab, resume } = testDeps({ structured: true })

    await expect(runWorktreeAgentActivationGate(WORKTREE_ID, deps)).resolves.toBe('structured')

    expect(createTab).not.toHaveBeenCalled()
    expect(resume).not.toHaveBeenCalled()
  })

  it('does not activate a terminal for a stale structured sleeping projection', async () => {
    const tabId = structuredAgentSessionTabId(STALE_STRUCTURED_SESSION_ID)
    const stale = sleepingRecord(tabId, LIVE_LEAF_ID, STALE_STRUCTURED_SESSION_ID)
    const { deps, createTab, resume } = testDeps({ structured: true, sleeping: [stale] })

    await expect(runWorktreeAgentActivationGate(WORKTREE_ID, deps)).resolves.toBe('blocked')

    expect(createTab).not.toHaveBeenCalled()
    expect(resume).not.toHaveBeenCalled()
  })

  it('does not resume when the runtime reports a structured session before tab sync', async () => {
    const { deps, createTab, resume } = testDeps({})
    const hasStructuredSession = vi.fn(async () => true)

    await expect(
      runWorktreeAgentActivationGate(WORKTREE_ID, { ...deps, hasStructuredSession })
    ).resolves.toBe('structured')

    expect(hasStructuredSession).toHaveBeenCalledWith(WORKTREE_ID)
    expect(createTab).not.toHaveBeenCalled()
    expect(resume).not.toHaveBeenCalled()
  })

  it('keeps the existing resume path when the workspace has no live agent', async () => {
    const { deps, createTab, resume } = testDeps({})

    await expect(runWorktreeAgentActivationGate(WORKTREE_ID, deps)).resolves.toBe('resumed')

    expect(createTab).not.toHaveBeenCalled()
    expect(resume).toHaveBeenCalledOnce()
    expect(resume).toHaveBeenCalledWith(WORKTREE_ID, { skipClaimKeys: new Set() })
  })

  it('resumes a dead agent when the workspace only has a non-agent PTY', async () => {
    const dead = sleepingRecord('tab-dead', DEAD_LEAF_ID, 'dead-session')
    const plainPtyId = `${WORKTREE_ID}@@plain-shell`
    const { deps, resume } = testDeps({
      sessions: [{ ...listed(plainPtyId), title: 'zsh', agentOwnership: 'absent' }],
      sleeping: [dead]
    })

    await expect(runWorktreeAgentActivationGate(WORKTREE_ID, deps)).resolves.toBe('resumed')

    expect(resume).toHaveBeenCalledWith(WORKTREE_ID, { skipClaimKeys: new Set() })
  })

  it('suppresses only the exact live agent session while resuming a dead sibling', async () => {
    const live = sleepingRecord('tab-live', LIVE_LEAF_ID, 'live-session')
    const dead = sleepingRecord('tab-dead', DEAD_LEAF_ID, 'dead-session')
    const livePtyId = `${WORKTREE_ID}@@live-agent`
    const { deps, resume } = testDeps({ sessions: [listed(livePtyId)], sleeping: [live, dead] })
    const store = deps.getState()
    store.terminalLayoutsByTabId['tab-live']!.ptyIdsByLeafId[LIVE_LEAF_ID] = livePtyId

    await expect(runWorktreeAgentActivationGate(WORKTREE_ID, deps)).resolves.toBe('resumed')

    expect(resume).toHaveBeenCalledWith(WORKTREE_ID, {
      skipClaimKeys: new Set([`${WORKTREE_ID}\0codex\0session_id\0live-session`])
    })
  })

  it.each(['present', 'unknown'] as const)(
    'does not resume OMP when a surfaced %s agent lacks conversation ownership',
    async (agentOwnership) => {
      const record = {
        ...sleepingRecord('old-tab', DEAD_LEAF_ID, 'omp-session'),
        agent: 'omp' as const
      }
      const ptyId = `${WORKTREE_ID}@@current-omp`
      const { deps, resume, createTab } = testDeps({
        sessions: [{ ...listed(ptyId), title: 'OMP', agentOwnership }],
        sleeping: [record],
        surfaceOwners: new Map([
          [
            ptyId,
            {
              ptyId,
              tabId: 'current-tab',
              paneKey: `current-tab:${LIVE_LEAF_ID}`
            }
          ]
        ])
      })
      seedExistingSurface(deps.getState(), {
        tabId: 'current-tab',
        leafId: LIVE_LEAF_ID,
        boundPtyId: ptyId
      })
      await expect(runWorktreeAgentActivationGate(WORKTREE_ID, deps)).resolves.toBe('blocked')
      expect(resume).not.toHaveBeenCalled()
      expect(createTab).not.toHaveBeenCalled()
      expect(deps.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toEqual(record)
    }
  )

  it('does not use an ambiguous tab binding as a live session claim', async () => {
    const live = sleepingRecord('tab-live', LIVE_LEAF_ID, 'live-session')
    const livePtyId = `${WORKTREE_ID}@@live-agent`
    const { deps, resume } = testDeps({ sessions: [listed(livePtyId)], sleeping: [live] })
    deps.getState().ptyIdsByTabId['tab-live'] = [livePtyId, `${WORKTREE_ID}@@other-agent`]

    await expect(runWorktreeAgentActivationGate(WORKTREE_ID, deps)).resolves.toBe('blocked')

    expect(resume).not.toHaveBeenCalled()
  })

  it('blocks when the host names no chat owner for a structured tab', async () => {
    // An older host can still answer that a terminal owns the session; that is no chat owner.
    const tabId = 'structured-agent-session-live-session'
    const live = sleepingRecord(tabId, LIVE_LEAF_ID, 'live-session')
    const livePtyId = `${WORKTREE_ID}@@live-agent`
    const { deps, resume } = testDeps({ sessions: [listed(livePtyId)], sleeping: [live] })

    await expect(
      runWorktreeAgentActivationGate(WORKTREE_ID, {
        ...deps,
        hasStructuredSession: async () => ({
          snapshot: runtimeSnapshot(tabId, LIVE_LEAF_ID, [livePtyId]),
          ownerBySessionId: new Map()
        })
      })
    ).resolves.toBe('blocked')

    expect(resume).not.toHaveBeenCalled()
  })

  it('suppresses the exact structured session when native already owns it', async () => {
    const tabId = 'structured-agent-session-live-session'
    const live = sleepingRecord(tabId, LIVE_LEAF_ID, 'live-session')
    const { deps, resume } = testDeps({ sleeping: [live], resumeCount: 0 })

    await expect(
      runWorktreeAgentActivationGate(WORKTREE_ID, {
        ...deps,
        hasStructuredSession: async () => ({
          snapshot: runtimeSnapshot(tabId, LIVE_LEAF_ID, []),
          ownerBySessionId: new Map([['live-session', { owner: 'native' }]])
        })
      })
    ).resolves.toBe('structured')

    expect(resume).toHaveBeenCalledWith(WORKTREE_ID, {
      skipClaimKeys: new Set([`${WORKTREE_ID}\0codex\0session_id\0live-session`])
    })
  })
  it('does not mint a second surface for a PTY bound only in the persisted layout', async () => {
    const livePtyId = `${WORKTREE_ID}@@live-agent`
    const { deps, createTab } = testDeps({ sessions: [listed(livePtyId)] })
    seedExistingSurface(deps.getState(), {
      tabId: 'tab-live',
      leafId: LIVE_LEAF_ID,
      boundPtyId: livePtyId
    })

    await expect(runWorktreeAgentActivationGate(WORKTREE_ID, deps)).resolves.toBe('adopted')

    expect(createTab).not.toHaveBeenCalled()
    expect(deps.listSurfaceOwners).not.toHaveBeenCalled()
  })

  it('does not mint a second surface for a PTY recorded only on the tab row', async () => {
    const livePtyId = `${WORKTREE_ID}@@live-agent`
    const { deps, createTab } = testDeps({ sessions: [listed(livePtyId)] })
    const store = deps.getState()
    seedExistingSurface(store, { tabId: 'tab-live', leafId: LIVE_LEAF_ID })
    store.tabsByWorktree[WORKTREE_ID]![0]!.ptyId = livePtyId

    await expect(runWorktreeAgentActivationGate(WORKTREE_ID, deps)).resolves.toBe('adopted')

    expect(createTab).not.toHaveBeenCalled()
  })

  it('restores the host-owned surface when the renderer projection lost every binding', async () => {
    const livePtyId = `${WORKTREE_ID}@@live-agent`
    const { deps, createTab } = testDeps({
      sessions: [listed(livePtyId)],
      surfaceOwners: new Map([
        [
          livePtyId,
          {
            paneKey: `tab-live:${LIVE_LEAF_ID}`,
            ptyId: livePtyId,
            tabId: 'tab-live'
          }
        ]
      ])
    })
    const store = deps.getState()
    seedExistingSurface(store, { tabId: 'tab-live', leafId: LIVE_LEAF_ID })

    await expect(runWorktreeAgentActivationGate(WORKTREE_ID, deps)).resolves.toBe('adopted')

    expect(createTab).not.toHaveBeenCalled()
    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      // Main's listing names the pane it holds and its frames rebind it; the window writes nothing.
      expectNoBindingWrite(store)
      return
    }
    expect(store.updateTabPtyId).toHaveBeenCalledWith('tab-live', livePtyId)
    expect(store.replaceTerminalLayoutPanePtyId).toHaveBeenCalledWith(
      'tab-live',
      LIVE_LEAF_ID,
      livePtyId
    )
  })

  // Layout-owner build: 'reads the host tab of a surface this renderer never mounted from main’s frames'.
  windowOwnedIt(
    'materializes the host tab id for a surface this renderer never mounted',
    async () => {
      const livePtyId = `${WORKTREE_ID}@@live-agent`
      const hostTabId = '3359f7c8-9bd8-4931-8104-52b6bdbd108d'
      const { deps, createTab } = testDeps({
        sessions: [listed(livePtyId)],
        surfaceOwners: new Map([
          [
            livePtyId,
            {
              paneKey: `${hostTabId}:${LIVE_LEAF_ID}`,
              ptyId: livePtyId,
              tabId: hostTabId
            }
          ]
        ])
      })

      await expect(runWorktreeAgentActivationGate(WORKTREE_ID, deps)).resolves.toBe('adopted')

      expect(createTab).toHaveBeenCalledOnce()
      expect(createTab).toHaveBeenCalledWith(WORKTREE_ID, undefined, undefined, {
        id: hostTabId,
        initialLeafId: LIVE_LEAF_ID,
        initialPtyId: livePtyId,
        activate: false,
        recordInteraction: false
      })
    }
  )

  // Unreadable census must not claim adopted without a surface; fail-closed still returns caller seeding responsibility.
  it('declines to mint but still asks for a seed when the host cannot answer', async () => {
    const livePtyId = `${WORKTREE_ID}@@live-agent`
    const { deps, createTab } = testDeps({
      sessions: [listed(livePtyId)],
      surfaceOwners: null,
      resumeCount: 0
    })

    await expect(runWorktreeAgentActivationGate(WORKTREE_ID, deps)).resolves.toBe('empty')

    expect(createTab).not.toHaveBeenCalled()
  })

  it('declines to mint but still asks for a seed when two host surfaces claim one live PTY', async () => {
    const livePtyId = `${WORKTREE_ID}@@live-agent`
    const { deps, createTab } = testDeps({
      sessions: [listed(livePtyId)],
      surfaceOwners: new Map([[livePtyId, null]]),
      resumeCount: 0
    })

    await expect(runWorktreeAgentActivationGate(WORKTREE_ID, deps)).resolves.toBe('empty')

    expect(createTab).not.toHaveBeenCalled()
  })

  it('reports a decline when the host names a leaf the persisted layout does not have', async () => {
    const livePtyId = `${WORKTREE_ID}@@live-agent`
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { deps, createTab } = testDeps({
      sessions: [listed(livePtyId)],
      surfaceOwners: new Map([
        [livePtyId, { paneKey: `tab-live:${SIBLING_LEAF_ID}`, ptyId: livePtyId, tabId: 'tab-live' }]
      ]),
      resumeCount: 0
    })
    seedExistingSurface(deps.getState(), { tabId: 'tab-live', leafId: LIVE_LEAF_ID })

    if (ORCA_LAYOUT_OWNER_IS_MAIN) {
      // Main holds the layout: the leaf it names is shown by its frames, so nothing is declined.
      await expect(runWorktreeAgentActivationGate(WORKTREE_ID, deps)).resolves.toBe('adopted')
      expect(createTab).not.toHaveBeenCalled()
      expectNoBindingWrite(deps.getState())
      expect(warn).not.toHaveBeenCalled()
      warn.mockRestore()
      return
    }
    // The seam re-checks its own guard, so an existing tab is not re-seeded by 'empty'.
    await expect(runWorktreeAgentActivationGate(WORKTREE_ID, deps)).resolves.toBe('empty')

    expect(createTab).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      '[worktree-activation] live PTYs left without a surface',
      expect.objectContaining({ worktreeId: WORKTREE_ID, declinedPtyIds: [livePtyId] })
    )
    warn.mockRestore()
  })

  windowOwnedIt('reports adopted only for the PTYs that actually landed on a surface', async () => {
    const adoptedPtyId = `${WORKTREE_ID}@@orphan-agent`
    const unverifiablePtyId = `${WORKTREE_ID}@@ambiguous-agent`
    const { deps } = testDeps({
      sessions: [listed(adoptedPtyId), listed(unverifiablePtyId)],
      surfaceOwners: new Map([
        [adoptedPtyId, UNOWNED],
        [unverifiablePtyId, null]
      ]),
      resumeCount: 0
    })

    await expect(runWorktreeAgentActivationGate(WORKTREE_ID, deps)).resolves.toBe('adopted')
  })

  it.each([
    ['ssh:box@@pty-1', WORKTREE_ID],
    [`${WORKTREE_ID}@@legacy`, ''],
    // Host ORCA_WORKTREE_ID may seed a foreign relay worktreeId; prefix-minted IDs must still include this workspace’s sessions.
    [`${WORKTREE_ID}@@stale-env`, 'other-repo::/elsewhere']
  ])(
    'adopts %s using workspace metadata or the legacy ID fallback',
    async (livePtyId, worktreeId) => {
      const { deps, createTab, resume } = testDeps({
        sessions: [{ ...listed(livePtyId), worktreeId }],
        surfaceOwners: new Map([
          [livePtyId, { paneKey: `tab-live:${LIVE_LEAF_ID}`, ptyId: livePtyId, tabId: 'tab-live' }]
        ])
      })
      const store = deps.getState()
      seedExistingSurface(store, { tabId: 'tab-live', leafId: LIVE_LEAF_ID })

      await expect(runWorktreeAgentActivationGate(WORKTREE_ID, deps)).resolves.toBe('adopted')
      expect(createTab).not.toHaveBeenCalled()
      expect(resume).not.toHaveBeenCalled()
      expect(store.terminalLayoutsByTabId['tab-live']?.ptyIdsByLeafId).toEqual(
        // Layout-owner build: main's frames bind the pane, not the window.
        ORCA_LAYOUT_OWNER_IS_MAIN ? {} : { [LIVE_LEAF_ID]: livePtyId }
      )
    }
  )

  it('adopts a host surface hydrated under a differently spelled workspace id', async () => {
    const livePtyId = `${WORKTREE_ID}@@live-agent`
    const { deps, createTab } = testDeps({
      sessions: [listed(livePtyId)],
      surfaceOwners: new Map([
        [livePtyId, { paneKey: `tab-live:${LIVE_LEAF_ID}`, ptyId: livePtyId, tabId: 'tab-live' }]
      ])
    })
    const store = deps.getState()
    seedExistingSurface(store, { tabId: 'tab-live', leafId: LIVE_LEAF_ID })
    // Packaged hydration can key the same workspace by an equivalent path spelling.
    store.tabsByWorktree[`${WORKTREE_ID}/`] = store.tabsByWorktree[WORKTREE_ID]!
    store.tabsByWorktree[WORKTREE_ID] = []

    await expect(runWorktreeAgentActivationGate(WORKTREE_ID, deps)).resolves.toBe('adopted')

    expect(createTab).not.toHaveBeenCalled()
    expect(store.terminalLayoutsByTabId['tab-live']?.ptyIdsByLeafId).toEqual(
      // Layout-owner build: main's frames bind the pane, not the window.
      ORCA_LAYOUT_OWNER_IS_MAIN ? {} : { [LIVE_LEAF_ID]: livePtyId }
    )
  })

  it('re-reads local ownership after the census before minting', async () => {
    const livePtyId = `${WORKTREE_ID}@@live-agent`
    const { deps, createTab } = testDeps({
      sessions: [listed(livePtyId)],
      surfaceOwners: new Map([[livePtyId, UNOWNED]])
    })
    const store = deps.getState()
    seedExistingSurface(store, { tabId: 'tab-live', leafId: LIVE_LEAF_ID })
    // The pane mounts while the census is in flight, binding the PTY behind the sweep.
    deps.listSurfaceOwners.mockImplementation(async () => {
      store.ptyIdsByTabId['tab-live'] = [livePtyId]
      return new Map([[livePtyId, UNOWNED]])
    })

    await expect(runWorktreeAgentActivationGate(WORKTREE_ID, deps)).resolves.toBe('adopted')

    expect(createTab).not.toHaveBeenCalled()
  })

  it('does not adopt a predecessor after the relay restarts between activation inventories', async () => {
    const predecessor = 'ssh:target@@pty2:old-relay:1'
    const replacement = 'ssh:target@@pty2:new-relay:1'
    const { deps, createTab } = testDeps({ resumeCount: 0 })
    const store = deps.getState()
    seedExistingSurface(store, {
      tabId: 'tab-live',
      leafId: LIVE_LEAF_ID,
      boundPtyId: predecessor
    })
    let replyWithOldInventory!: (sessions: PtyListedSession[]) => void
    deps.listSessions.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          replyWithOldInventory = resolve
        })
    )
    const activation = runWorktreeAgentActivationGate(WORKTREE_ID, deps)
    await vi.waitFor(() => expect(deps.listSessions).toHaveBeenCalledOnce())

    // Recovery rebinds the same pane before the old relay's inventory response arrives.
    store.terminalLayoutsByTabId['tab-live']!.ptyIdsByLeafId[LIVE_LEAF_ID] = replacement
    store.ptyIdsByTabId['tab-live'] = [replacement]
    deps.listSurfaceOwners.mockResolvedValueOnce(indexLiveTerminalSurfaceOwners([], WORKTREE_ID))
    replyWithOldInventory([{ ...listed(predecessor), worktreeId: WORKTREE_ID }])
    await activation

    expect(createTab).not.toHaveBeenCalled()
    expect(store.tabsByWorktree[WORKTREE_ID]?.map((tab) => tab.id)).toEqual(['tab-live'])
    expect(store.terminalLayoutsByTabId['tab-live']?.ptyIdsByLeafId[LIVE_LEAF_ID]).toBe(replacement)
  })

  // Layout-owner build: 'leaves every host pane of an unmounted tab to main’s frames'.
  windowOwnedIt('gives every host pane of an unmounted tab its own leaf', async () => {
    const firstPtyId = `${WORKTREE_ID}@@live-agent`
    const secondPtyId = `${WORKTREE_ID}@@live-sibling`
    const hostTabId = '3359f7c8-9bd8-4931-8104-52b6bdbd108d'
    const { deps, createTab } = testDeps({
      sessions: [listed(firstPtyId), listed(secondPtyId)],
      surfaceOwners: new Map([
        [
          firstPtyId,
          { paneKey: `${hostTabId}:${LIVE_LEAF_ID}`, ptyId: firstPtyId, tabId: hostTabId }
        ],
        [
          secondPtyId,
          { paneKey: `${hostTabId}:${SIBLING_LEAF_ID}`, ptyId: secondPtyId, tabId: hostTabId }
        ]
      ])
    })
    const store = deps.getState()

    await expect(runWorktreeAgentActivationGate(WORKTREE_ID, deps)).resolves.toBe('adopted')

    expect(createTab).toHaveBeenCalledOnce()
    expect(store.terminalLayoutsByTabId[hostTabId]?.root).toEqual({
      type: 'split',
      direction: 'horizontal',
      first: { type: 'leaf', leafId: LIVE_LEAF_ID },
      second: { type: 'leaf', leafId: SIBLING_LEAF_ID }
    })
    expect(store.terminalLayoutsByTabId[hostTabId]?.ptyIdsByLeafId).toEqual({
      [LIVE_LEAF_ID]: firstPtyId,
      [SIBLING_LEAF_ID]: secondPtyId
    })
  })

  // Layout-owner build: 'makes no surface for a live PTY main has not placed yet, and resumes no agent over it'.
  windowOwnedIt('still adopts a live PTY the host reports as owned by no surface', async () => {
    const livePtyId = `${WORKTREE_ID}@@orphan-agent`
    const { deps, createTab } = testDeps({
      sessions: [listed(livePtyId)],
      surfaceOwners: new Map([[livePtyId, UNOWNED]])
    })

    await expect(runWorktreeAgentActivationGate(WORKTREE_ID, deps)).resolves.toBe('adopted')

    expect(createTab).toHaveBeenCalledWith(WORKTREE_ID, undefined, undefined, {
      initialPtyId: livePtyId,
      activate: false,
      recordInteraction: false
    })
  })
})
