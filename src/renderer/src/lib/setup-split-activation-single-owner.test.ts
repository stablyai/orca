import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store'
import { useAppStore } from '@/store'
import { registerTerminalPresentationIpcBridge } from '@/hooks/ipc-events/terminal-presentation-ipc-bridge'
import { getDefaultSettings } from '../../../shared/constants'
import type { RuntimeTerminalSummary } from '../../../shared/runtime-types'
import type { TerminalPaneLayoutNode } from '../../../shared/terminal-tab-types'
import { activateAndRevealWorktree } from './worktree-activation'
import { gateWorktreeAgentActivation } from './worktree-agent-activation-gate'
import { makeCreatedAgentWorktree as makeWorktree } from './worktree-activation-created-agent-test-state'

/**
 * STA-9417, converted from the natural repro: a host-created worktree whose setup script runs in a
 * split of the (unmounted) primary tab, then the first activation of that worktree. When main's
 * split reveal does not reach the window, the activation sweep mints a second tab for the setup
 * PTY, so two saved panes own one terminal and one of them freezes.
 */

const initialState = useAppStore.getState()
const TAB_B = 'b3f1c1de-5e0f-4a51-9d0c-7a8e2a9f6b11'
const PRIMARY_LEAF = '11111111-1111-4111-8111-111111111111'
const SETUP_LEAF = '22222222-2222-4222-8222-222222222222'

type CreateTerminalListener = Parameters<Window['api']['ui']['onCreateTerminal']>[0]

function baseState(): Partial<AppState> {
  const worktree = makeWorktree()
  return {
    repos: [
      {
        id: worktree.repoId,
        path: path.join(path.sep, 'workspace', 'repo'),
        displayName: 'repo',
        badgeColor: '#000000',
        addedAt: 0
      }
    ],
    worktreesByRepo: { [worktree.repoId]: [worktree] },
    activeRepoId: worktree.repoId,
    activeView: 'terminal',
    workspaceSessionReady: true,
    terminalStartupRestorationReady: true,
    tabsByWorktree: {},
    ptyIdsByTabId: {},
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    layoutByWorktree: {},
    activeGroupIdByWorktree: {},
    terminalLayoutsByTabId: {},
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
    settings: {
      ...getDefaultSettings(path.join(path.sep, 'home')),
      agentCmdOverrides: {},
      defaultTuiAgent: 'codex',
      setupScriptLaunchMode: 'split-vertical'
    },
    markWorktreeVisited: vi.fn(),
    recordWorktreeVisit: vi.fn(),
    refreshGitHubForWorktreeIfStale: vi.fn(),
    revealWorktreeInSidebar: vi.fn()
  }
}

/** The host's census: both panes are unmounted, so it reports them unowned with their record. */
function orphanRow(ptyId: string, leafId: string): RuntimeTerminalSummary {
  const worktree = makeWorktree()
  return {
    handle: `handle-${leafId}`,
    ptyId,
    orphaned: true,
    recordedPaneKey: `${TAB_B}:${leafId}`,
    worktreeId: worktree.id,
    worktreePath: worktree.path,
    branch: worktree.branch ?? 'main',
    tabId: `pty:${ptyId}`,
    leafId: `pty:${ptyId}`,
    title: 'Terminal',
    connected: true,
    writable: true,
    lastOutputAt: null,
    preview: ''
  }
}

function stubHost(
  primaryPtyId: string,
  setupPtyId: string
): { reveal: () => CreateTerminalListener } {
  const worktree = makeWorktree()
  let listener: CreateTerminalListener | undefined
  const runtimeCall = vi.fn(async ({ method }: { method: string }) => {
    if (method === 'session.tabs.list') {
      return {
        ok: true,
        result: {
          worktree: worktree.id,
          publicationEpoch: 'sta-9417',
          snapshotVersion: 1,
          activeGroupId: null,
          activeTabId: null,
          activeTabType: null,
          tabs: []
        }
      }
    }
    if (method === 'terminal.list') {
      return {
        ok: true,
        result: {
          terminals: [orphanRow(primaryPtyId, PRIMARY_LEAF), orphanRow(setupPtyId, SETUP_LEAF)],
          truncated: false,
          hostScope: { hostIds: ['local'], omittedHostIds: [] }
        }
      }
    }
    throw new Error(`Unexpected runtime method: ${method}`)
  })
  const listSessions = vi.fn(async () =>
    [primaryPtyId, setupPtyId].map((id) => ({
      id,
      cwd: worktree.path,
      title: 'Terminal',
      agentOwnership: 'absent' as const
    }))
  )
  vi.stubGlobal('window', {
    api: {
      runtime: { call: runtimeCall },
      pty: { listSessions },
      ui: {
        onCreateTerminal: (next: CreateTerminalListener) => {
          listener = next
          return () => {}
        },
        onRequestTerminalTabMount: () => () => {},
        replyTerminalCreate: vi.fn()
      }
    },
    dispatchEvent: vi.fn()
  })
  return {
    reveal: () => {
      if (!listener) {
        throw new Error('presentation bridge did not register')
      }
      return listener
    }
  }
}

/** Main's background reveal of the primary terminal: the tab exists here but never mounted. */
function seedRevealedPrimaryTab(worktreeId: string, primaryPtyId: string): void {
  useAppStore.getState().createTab(worktreeId, undefined, undefined, {
    id: TAB_B,
    initialLeafId: PRIMARY_LEAF,
    initialPtyId: primaryPtyId,
    activate: false,
    recordInteraction: false
  })
}

function leafIdsInOrder(node: TerminalPaneLayoutNode | null): string[] {
  if (!node) {
    return []
  }
  return node.type === 'leaf'
    ? [node.leafId]
    : [...leafIdsInOrder(node.first), ...leafIdsInOrder(node.second)]
}

function setupSplitReveal(
  requestId: string,
  worktreeId: string,
  setupPtyId: string
): Parameters<CreateTerminalListener>[0] {
  return {
    requestId,
    worktreeId,
    ptyId: setupPtyId,
    activate: false,
    surfaceOwner: false,
    tabId: TAB_B,
    leafId: SETUP_LEAF,
    splitFromLeafId: PRIMARY_LEAF,
    splitDirection: 'vertical'
  }
}

/** ptyId → every tab:leaf in the worktree that holds it. */
function ownersByPty(worktreeId: string): Map<string, string[]> {
  const state = useAppStore.getState()
  const owners = new Map<string, string[]>()
  for (const tab of state.tabsByWorktree[worktreeId] ?? []) {
    const layout = state.terminalLayoutsByTabId[tab.id]
    for (const leafId of leafIdsInOrder(layout?.root ?? null)) {
      const ptyId = layout?.ptyIdsByLeafId?.[leafId]
      if (ptyId) {
        owners.set(ptyId, [...(owners.get(ptyId) ?? []), `${tab.id}:${leafId}`])
      }
    }
  }
  return owners
}

/** The sidebar click, then the first-activation sweep the terminal watcher runs (STA-9417 step 2). */
async function activateFirstTime(worktreeId: string): Promise<void> {
  activateAndRevealWorktree(worktreeId)
  await expect(gateWorktreeAgentActivation(worktreeId)).resolves.toBe('adopted')
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  useAppStore.setState(initialState, true)
})

describe('STA-9417: setup split of an unmounted tab, then first activation', () => {
  async function runScenario(revealSplit: boolean): Promise<void> {
    const worktree = makeWorktree()
    const primaryPtyId = `${worktree.id}@@primary`
    const setupPtyId = `${worktree.id}@@setup`
    useAppStore.setState(baseState())
    const host = stubHost(primaryPtyId, setupPtyId)
    registerTerminalPresentationIpcBridge([])
    seedRevealedPrimaryTab(worktree.id, primaryPtyId)

    if (revealSplit) {
      host.reveal()(setupSplitReveal('reveal-setup-split', worktree.id, setupPtyId))
    }
    await activateFirstTime(worktree.id)

    const tabs = useAppStore.getState().tabsByWorktree[worktree.id] ?? []
    expect(tabs.map((tab) => tab.id)).toEqual([TAB_B])
    expect(Object.fromEntries(ownersByPty(worktree.id))).toEqual({
      [primaryPtyId]: [`${TAB_B}:${PRIMARY_LEAF}`],
      [setupPtyId]: [`${TAB_B}:${SETUP_LEAF}`]
    })
  }

  it('ends with one tab and one owner per terminal when main reveals the split', async () => {
    await runScenario(true)
  })

  // STA-9417: fails until the mirror refactor (B2-4) pushes main's split before the sweep runs.
  it.fails('ends with one tab and one owner per terminal when the split reveal never arrives', async () => {
    await runScenario(false)
  })

  // STA-9417: fails until the mirror refactor (B2-4); the odd runs mint the duplicate.
  it.fails('stays duplicate-free across 8 create-then-activate cycles, with or without the reveal', async () => {
    let duplicates = 0
    for (let run = 0; run < 8; run++) {
      const worktree = makeWorktree()
      const primaryPtyId = `${worktree.id}@@primary-${run}`
      const setupPtyId = `${worktree.id}@@setup-${run}`
      useAppStore.setState(initialState, true)
      useAppStore.setState(baseState())
      const host = stubHost(primaryPtyId, setupPtyId)
      registerTerminalPresentationIpcBridge([])
      seedRevealedPrimaryTab(worktree.id, primaryPtyId)
      // Odd runs lose the reveal, as the natural repro did.
      if (run % 2 === 0) {
        host.reveal()(setupSplitReveal(`reveal-${run}`, worktree.id, setupPtyId))
      }
      await activateFirstTime(worktree.id)
      duplicates += [...ownersByPty(worktree.id).values()].filter(
        (owners) => owners.length > 1
      ).length
      duplicates += (useAppStore.getState().tabsByWorktree[worktree.id] ?? []).length - 1
    }
    expect(duplicates).toBe(0)
  })
})
