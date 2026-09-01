import { describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { structuredAgentSessionTabId } from '../../../shared/structured-agent-session-projection'
import type { PtyListedSession } from '../../../shared/pty-listed-session'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import { singlePaneLayoutSnapshot } from '@/store/slices/terminal-helpers'
import type { TerminalSlice } from '@/store/slices/terminals'
import { runWorktreeAgentActivationGate } from './worktree-agent-activation-gate'
import type { LiveTerminalSurfaceOwnerIndex } from './worktree-live-terminal-surface-owners'

const WORKTREE_ID = 'repo::/worktree'
const STALE_STRUCTURED_SESSION_ID = 'structured-session-stale'
const LIVE_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const DEAD_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const SIBLING_LEAF_ID = '33333333-3333-4333-8333-333333333333'

function listed(id: string): PtyListedSession {
  return { id, cwd: '/worktree', title: 'Codex', agentOwnership: 'present' }
}

function sleepingRecord(
  tabId: string,
  leafId: string,
  providerSessionId: string
): SleepingAgentSessionRecord {
  return {
    paneKey: `${tabId}:${leafId}`,
    tabId,
    worktreeId: WORKTREE_ID,
    agent: 'codex',
    providerSession: { key: 'session_id', id: providerSessionId },
    prompt: 'resume',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1
  }
}

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

/** The gate's own fixtures index panes by leaf, so keep that map materialized. */
type SeededLayout = TerminalLayoutSnapshot & { ptyIdsByLeafId: Record<string, string> }

function testDeps(args: {
  sessions?: PtyListedSession[]
  sleeping?: SleepingAgentSessionRecord[]
  structured?: boolean
  resumeCount?: number
  /** Host census of PTY→surface ownership; null models a host that could not answer. */
  surfaceOwners?: LiveTerminalSurfaceOwnerIndex | null
}) {
  const resume = vi.fn(() => args.resumeCount ?? 1)
  const sleeping = args.sleeping ?? []
  const ptyIdsByTabId: Record<string, string[]> = {}
  const tabsByWorktree: Record<string, TerminalTab[]> = { [WORKTREE_ID]: [] }
  const terminalLayoutsByTabId: Record<string, SeededLayout> = Object.fromEntries(
    sleeping.map((record) => {
      const leafId = record.paneKey.slice(record.paneKey.indexOf(':') + 1)
      return [
        record.tabId!,
        {
          root: { type: 'leaf' as const, leafId },
          activeLeafId: leafId,
          expandedLeafId: null,
          ptyIdsByLeafId: {}
        }
      ]
    })
  )
  const setTabLayout: TerminalSlice['setTabLayout'] = vi.fn((tabId, layout) => {
    if (!layout) {
      delete terminalLayoutsByTabId[tabId]
      return
    }
    terminalLayoutsByTabId[tabId] = { ...layout, ptyIdsByLeafId: { ...layout.ptyIdsByLeafId } }
  })
  const replaceTerminalLayoutPanePtyId = vi.fn((tabId: string, leafId: string, ptyId: string) => {
    const layout = terminalLayoutsByTabId[tabId]
    if (layout) {
      layout.ptyIdsByLeafId[leafId] = ptyId
    }
  })
  let createdCount = 0
  const createTab: TerminalSlice['createTab'] = vi.fn((worktreeId, _group, _shell, options) => {
    createdCount += 1
    const id = options?.id ?? `created-${createdCount}`
    const tab: TerminalTab = {
      id,
      ptyId: options?.initialPtyId ?? null,
      worktreeId,
      title: 'Terminal',
      customTitle: null,
      color: null,
      sortOrder: tabsByWorktree[worktreeId]?.length ?? 0,
      createdAt: 1
    }
    tabsByWorktree[worktreeId] ??= []
    tabsByWorktree[worktreeId].push(tab)
    ptyIdsByTabId[tab.id] = tab.ptyId ? [tab.ptyId] : []
    if (options?.initialLeafId) {
      setTabLayout(id, singlePaneLayoutSnapshot(options.initialLeafId, options.initialPtyId))
    }
    return tab
  })
  const updateTabPtyId = vi.fn((tabId: string, ptyId: string) => {
    ptyIdsByTabId[tabId] = [...new Set([...(ptyIdsByTabId[tabId] ?? []), ptyId])]
  })
  const store = {
    createTab,
    ptyIdsByTabId,
    setTabLayout,
    tabsByWorktree,
    sleepingAgentSessionsByPaneKey: Object.fromEntries(
      sleeping.map((record) => [record.paneKey, record])
    ),
    updateTabPtyId,
    replaceTerminalLayoutPanePtyId,
    terminalLayoutsByTabId,
    unifiedTabsByWorktree: {
      [WORKTREE_ID]: args.structured
        ? [
            {
              id: 'structured-1',
              entityId: 'session-1',
              groupId: 'group-1',
              worktreeId: WORKTREE_ID,
              contentType: 'agent-session' as const,
              label: 'Codex',
              customLabel: null,
              color: null,
              sortOrder: 0,
              createdAt: 1
            }
          ]
        : []
    }
  }
  return {
    createTab,
    resume,
    deps: {
      getState: () => store,
      listSessions: vi.fn(async () => args.sessions ?? []),
      listSurfaceOwners: vi.fn(async () =>
        args.surfaceOwners === undefined ? new Map() : args.surfaceOwners
      ),
      resume
    }
  }
}

function seedExistingSurface(
  store: ReturnType<ReturnType<typeof testDeps>['deps']['getState']>,
  args: { tabId: string; leafId: string; boundPtyId?: string }
): void {
  store.tabsByWorktree[WORKTREE_ID] = [
    ...(store.tabsByWorktree[WORKTREE_ID] ?? []),
    {
      id: args.tabId,
      ptyId: null,
      worktreeId: WORKTREE_ID,
      title: 'Terminal',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    }
  ]
  store.terminalLayoutsByTabId[args.tabId] = {
    root: { type: 'leaf' as const, leafId: args.leafId },
    activeLeafId: args.leafId,
    expandedLeafId: null,
    ptyIdsByLeafId: args.boundPtyId ? { [args.leafId]: args.boundPtyId } : {}
  }
}

describe('worktree agent activation gate', () => {
  it('uses immediately ready development restore inventory', async () => {
    const ptyId = `${WORKTREE_ID}@@live-pty`
    const { deps, createTab, resume } = testDeps({ sessions: [listed(ptyId)] })
    const awaitReady = vi.fn(async () => true)

    await expect(
      runWorktreeAgentActivationGate(WORKTREE_ID, { ...deps, awaitReady })
    ).resolves.toBe('adopted')

    expect(awaitReady).toHaveBeenCalledOnce()
    expect(createTab).toHaveBeenCalledOnce()
    expect(resume).not.toHaveBeenCalled()
  })

  it('waits for packaged restore hydration before reading daemon inventory', async () => {
    const ptyId = `${WORKTREE_ID}@@live-pty`
    const { deps, createTab, resume } = testDeps({ sessions: [listed(ptyId)] })
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
  })

  it('reads structured ownership before adopting daemon PTYs', async () => {
    const ptyId = `${WORKTREE_ID}@@live-pty`
    const { deps } = testDeps({ sessions: [listed(ptyId)] })
    const hasStructuredSession = vi.fn(async () => false)

    await runWorktreeAgentActivationGate(WORKTREE_ID, { ...deps, hasStructuredSession })

    expect(hasStructuredSession.mock.invocationCallOrder[0]).toBeLessThan(
      deps.listSessions.mock.invocationCallOrder[0] ?? Infinity
    )
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

  it('adopts a live daemon PTY before activation can resume another agent', async () => {
    const ptyId = `${WORKTREE_ID}@@live-pty`
    const { deps, createTab, resume } = testDeps({ sessions: [listed(ptyId)] })

    await expect(runWorktreeAgentActivationGate(WORKTREE_ID, deps)).resolves.toBe('adopted')

    expect(createTab).toHaveBeenCalledWith(WORKTREE_ID, undefined, undefined, {
      initialPtyId: ptyId,
      activate: false,
      recordInteraction: false
    })
    expect(resume).not.toHaveBeenCalled()
  })

  it('adopts a daemon PTY minted for a folder workspace', async () => {
    const folderWorkspaceId = 'folder:plain-workspace'
    const ptyId = `${folderWorkspaceId}@@live-pty`
    const { deps, createTab, resume } = testDeps({ sessions: [listed(ptyId)] })

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

  it('adopts the exact structured TUI surface without creating a duplicate tab', async () => {
    const tabId = 'structured-agent-session-live-session'
    const live = sleepingRecord(tabId, LIVE_LEAF_ID, 'live-session')
    const livePtyId = `${WORKTREE_ID}@@live-agent`
    const { deps, createTab, resume } = testDeps({
      sessions: [listed(livePtyId)],
      sleeping: [live],
      resumeCount: 0
    })
    const ownerTabId = '3359f7c8-9bd8-4931-8104-52b6bdbd108d'
    const ownerLeafId = '2659ee80-d3fc-454f-b4ea-0638de1ae345'

    await expect(
      runWorktreeAgentActivationGate(WORKTREE_ID, {
        ...deps,
        hasStructuredSession: async () => ({
          snapshot: runtimeSnapshot(tabId, LIVE_LEAF_ID, [livePtyId]),
          ownerBySessionId: new Map([
            [
              'live-session',
              {
                owner: 'tui',
                terminal: {
                  paneKey: `${ownerTabId}:${ownerLeafId}`,
                  ptyId: livePtyId,
                  tabId: ownerTabId
                }
              }
            ]
          ])
        })
      })
    ).resolves.toBe('adopted')

    expect(createTab).toHaveBeenCalledOnce()
    expect(createTab).toHaveBeenCalledWith(WORKTREE_ID, undefined, undefined, {
      id: ownerTabId,
      initialLeafId: ownerLeafId,
      initialPtyId: livePtyId,
      activate: false,
      recordInteraction: false
    })
    expect(resume).toHaveBeenCalledWith(WORKTREE_ID, {
      skipClaimKeys: new Set([`${WORKTREE_ID}\0codex\0session_id\0live-session`])
    })
  })

  it('does not use an ambiguous tab binding as a live session claim', async () => {
    const live = sleepingRecord('tab-live', LIVE_LEAF_ID, 'live-session')
    const livePtyId = `${WORKTREE_ID}@@live-agent`
    const { deps, resume } = testDeps({ sessions: [listed(livePtyId)], sleeping: [live] })
    deps.getState().ptyIdsByTabId['tab-live'] = [livePtyId, `${WORKTREE_ID}@@other-agent`]

    await expect(runWorktreeAgentActivationGate(WORKTREE_ID, deps)).resolves.toBe('resumed')

    expect(resume).toHaveBeenCalledWith(WORKTREE_ID, { skipClaimKeys: new Set() })
  })

  it('blocks when a structured TUI owner is absent from live inventory', async () => {
    const tabId = 'structured-agent-session-live-session'
    const live = sleepingRecord(tabId, LIVE_LEAF_ID, 'live-session')
    const livePtyId = `${WORKTREE_ID}@@live-agent`
    const { deps, resume } = testDeps({ sessions: [listed(livePtyId)], sleeping: [live] })

    await expect(
      runWorktreeAgentActivationGate(WORKTREE_ID, {
        ...deps,
        hasStructuredSession: async () => ({
          snapshot: runtimeSnapshot(tabId, LIVE_LEAF_ID, [livePtyId]),
          ownerBySessionId: new Map([
            [
              'live-session',
              {
                owner: 'tui',
                terminal: {
                  paneKey: live.paneKey,
                  ptyId: `${WORKTREE_ID}@@different-agent`,
                  tabId
                }
              }
            ]
          ])
        })
      })
    ).resolves.toBe('blocked')

    expect(resume).not.toHaveBeenCalled()
  })

  it('uses the restored owner surface even when its tab predates structured naming', async () => {
    const tabId = 'structured-agent-session-other-session'
    const live = sleepingRecord(tabId, LIVE_LEAF_ID, 'live-session')
    const livePtyId = `${WORKTREE_ID}@@live-agent`
    const { deps, resume } = testDeps({ sessions: [listed(livePtyId)], sleeping: [live] })

    await expect(
      runWorktreeAgentActivationGate(WORKTREE_ID, {
        ...deps,
        hasStructuredSession: async () => ({
          snapshot: runtimeSnapshot(tabId, LIVE_LEAF_ID, [livePtyId]),
          ownerBySessionId: new Map([
            [
              'live-session',
              {
                owner: 'tui',
                terminal: { paneKey: live.paneKey, ptyId: livePtyId, tabId }
              }
            ]
          ])
        })
      })
    ).resolves.toBe('resumed')

    expect(resume).toHaveBeenCalledWith(WORKTREE_ID, {
      skipClaimKeys: new Set([`${WORKTREE_ID}\0codex\0session_id\0live-session`])
    })
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
    expect(store.updateTabPtyId).toHaveBeenCalledWith('tab-live', livePtyId)
    expect(store.replaceTerminalLayoutPanePtyId).toHaveBeenCalledWith(
      'tab-live',
      LIVE_LEAF_ID,
      livePtyId
    )
  })

  it('materializes the host tab id for a surface this renderer never mounted', async () => {
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
  })

  // Failing closed must not also fail silent: an unreadable census leaves the workspace with
  // no surface, so the gate has to hand the caller its seed instead of claiming 'adopted'.
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

    // The seam re-checks its own guard, so an existing tab is not re-seeded by 'empty'.
    await expect(runWorktreeAgentActivationGate(WORKTREE_ID, deps)).resolves.toBe('empty')

    expect(createTab).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(
      '[worktree-activation] live PTYs left without a surface',
      expect.objectContaining({ worktreeId: WORKTREE_ID, declinedPtyIds: [livePtyId] })
    )
    warn.mockRestore()
  })

  it('reports adopted only for the PTYs that actually landed on a surface', async () => {
    const adoptedPtyId = `${WORKTREE_ID}@@orphan-agent`
    const unverifiablePtyId = `${WORKTREE_ID}@@ambiguous-agent`
    const { deps } = testDeps({
      sessions: [listed(adoptedPtyId), listed(unverifiablePtyId)],
      surfaceOwners: new Map([[unverifiablePtyId, null]]),
      resumeCount: 0
    })

    await expect(runWorktreeAgentActivationGate(WORKTREE_ID, deps)).resolves.toBe('adopted')
  })

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
    expect(store.terminalLayoutsByTabId['tab-live']?.ptyIdsByLeafId).toEqual({
      [LIVE_LEAF_ID]: livePtyId
    })
  })

  it('re-reads local ownership after the census before minting', async () => {
    const livePtyId = `${WORKTREE_ID}@@live-agent`
    const { deps, createTab } = testDeps({
      sessions: [listed(livePtyId)],
      surfaceOwners: new Map()
    })
    const store = deps.getState()
    seedExistingSurface(store, { tabId: 'tab-live', leafId: LIVE_LEAF_ID })
    // The pane mounts while the census is in flight, binding the PTY behind the sweep.
    deps.listSurfaceOwners.mockImplementation(async () => {
      store.ptyIdsByTabId['tab-live'] = [livePtyId]
      return new Map()
    })

    await expect(runWorktreeAgentActivationGate(WORKTREE_ID, deps)).resolves.toBe('adopted')

    expect(createTab).not.toHaveBeenCalled()
  })

  it('gives every host pane of an unmounted tab its own leaf', async () => {
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

  it('still adopts a live PTY the host reports as owned by no surface', async () => {
    const livePtyId = `${WORKTREE_ID}@@orphan-agent`
    const { deps, createTab } = testDeps({
      sessions: [listed(livePtyId)],
      surfaceOwners: new Map()
    })

    await expect(runWorktreeAgentActivationGate(WORKTREE_ID, deps)).resolves.toBe('adopted')

    expect(createTab).toHaveBeenCalledWith(WORKTREE_ID, undefined, undefined, {
      initialPtyId: livePtyId,
      activate: false,
      recordInteraction: false
    })
  })
})
