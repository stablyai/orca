// The activation gate's fake store and inventory, shared by its window-owned and layout-owner tests.
import { vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { PtyListedSession } from '../../../shared/pty-listed-session'
import type { TerminalLayoutSnapshot, TerminalTab } from '../../../shared/terminal-tab-types'
import { singlePaneLayoutSnapshot } from '@/store/slices/terminal-helpers'
import type { TerminalSlice } from '@/store/slices/terminals'
import type {
  LiveTerminalSurfaceOwnerIndex,
  UnownedLiveTerminal
} from './worktree-live-terminal-surface-owners'

export const WORKTREE_ID = 'repo::/worktree'
export const LIVE_LEAF_ID = '11111111-1111-4111-8111-111111111111'
export const DEAD_LEAF_ID = '22222222-2222-4222-8222-222222222222'
export const SIBLING_LEAF_ID = '33333333-3333-4333-8333-333333333333'
export const UNOWNED: UnownedLiveTerminal = { unowned: true, recorded: null }

export function listed(id: string): PtyListedSession {
  return { id, cwd: '/worktree', title: 'Codex', agentOwnership: 'present' }
}

export function sleepingRecord(
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

/** The gate's own fixtures index panes by leaf, so keep that map materialized. */
export type SeededLayout = TerminalLayoutSnapshot & { ptyIdsByLeafId: Record<string, string> }

export function testDeps(args: {
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

export type GateTestStore = ReturnType<ReturnType<typeof testDeps>['deps']['getState']>

export function seedExistingSurface(
  store: GateTestStore,
  args: { tabId: string; leafId: string; boundPtyId?: string; worktreeId?: string }
): void {
  const worktreeId = args.worktreeId ?? WORKTREE_ID
  store.tabsByWorktree[worktreeId] = [
    ...(store.tabsByWorktree[worktreeId] ?? []),
    {
      id: args.tabId,
      ptyId: null,
      worktreeId,
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
