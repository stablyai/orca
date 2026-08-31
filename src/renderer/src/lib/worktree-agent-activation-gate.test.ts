import { describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { structuredAgentSessionTabId } from '../../../shared/structured-agent-session-projection'
import type { PtyListedSession } from '../../../shared/pty-listed-session'
import type { RuntimeMobileSessionTabsResult } from '../../../shared/runtime-types'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { TerminalSlice } from '@/store/slices/terminals'
import { runWorktreeAgentActivationGate } from './worktree-agent-activation-gate'

const WORKTREE_ID = 'repo::/worktree'
const STALE_STRUCTURED_SESSION_ID = 'structured-session-stale'
const LIVE_LEAF_ID = '11111111-1111-4111-8111-111111111111'
const DEAD_LEAF_ID = '22222222-2222-4222-8222-222222222222'

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

function testDeps(args: {
  sessions?: PtyListedSession[]
  sleeping?: SleepingAgentSessionRecord[]
  structured?: boolean
  resumeCount?: number
}) {
  const resume = vi.fn(() => args.resumeCount ?? 1)
  const sleeping = args.sleeping ?? []
  const ptyIdsByTabId: Record<string, string[]> = {}
  const tabsByWorktree: Record<string, TerminalTab[]> = { [WORKTREE_ID]: [] }
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
    return tab
  })
  const updateTabPtyId = vi.fn((tabId: string, ptyId: string) => {
    ptyIdsByTabId[tabId] = [...new Set([...(ptyIdsByTabId[tabId] ?? []), ptyId])]
  })
  const store = {
    createTab,
    ptyIdsByTabId,
    tabsByWorktree,
    sleepingAgentSessionsByPaneKey: Object.fromEntries(
      sleeping.map((record) => [record.paneKey, record])
    ),
    updateTabPtyId,
    replaceTerminalLayoutPanePtyId: vi.fn(),
    terminalLayoutsByTabId: Object.fromEntries(
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
    ),
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
      resume
    }
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
})
