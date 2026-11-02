// Stored session partitions shaped the way today's writers leave them, for the Loader/Serializer
// round trip, built the way the window saves them. Each terminal tab has its row, tab-bar entry and pane layout; order fields agree.

import { getDefaultWorkspaceSession } from '../constants'
import { LOCAL_EXECUTION_HOST_ID, type ExecutionHostId } from '../execution-host'
import type { Tab, TabGroup } from '../tab-types'
import type {
  TerminalLayoutSnapshot,
  TerminalPaneLayoutNode,
  TerminalTab
} from '../terminal-tab-types'
import type { WorkspaceSessionState } from '../workspace-session-state-types'
import { folderWorkspaceKey } from '../workspace-scope'

export const GIT_KEY = 'repo-1::/Users/dev/orca'
export const FOLDER_KEY = folderWorkspaceKey('notes-1')
export const SSH_KEY = 'repo-ssh::/home/dev/api'
export const SERVER_KEY = 'repo-server::/srv/app'

export const leaf = (n: number): string =>
  `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`

type TerminalSpec = {
  /** Tab-bar id; the row, pane layout and pane keys use `entityId` (this id when absent). */
  id: string
  entityId?: string
  leaves: [string, string?][]
  title?: string
  split?: 'vertical' | 'horizontal'
  row?: Partial<TerminalTab>
  entry?: Partial<Tab>
  layout?: Partial<TerminalLayoutSnapshot>
}

type ContentSpec = {
  id: string
  entityId?: string
  kind: Exclude<Tab['contentType'], 'terminal'>
  entry?: Partial<Tab>
}

type GroupSpec = {
  id: string
  tabs: (TerminalSpec | ContentSpec)[]
  activeTabId?: string | null
  recent?: string[]
}

function paneTree(leafIds: string[], direction: 'vertical' | 'horizontal'): TerminalPaneLayoutNode {
  const [first, ...rest] = leafIds
  const node: TerminalPaneLayoutNode = { type: 'leaf', leafId: first! }
  return rest.length === 0
    ? node
    : { type: 'split', direction, ratio: 0.5, first: node, second: paneTree(rest, direction) }
}

const isTerminal = (spec: TerminalSpec | ContentSpec): spec is TerminalSpec => !('kind' in spec)

/** Adds one workspace's tabs the way the window saves them: rows, tab bar, groups, layouts. */
export function addWorkspace(
  session: WorkspaceSessionState,
  key: string,
  groups: GroupSpec[],
  hostId: ExecutionHostId = LOCAL_EXECUTION_HOST_ID
): WorkspaceSessionState {
  const rows: TerminalTab[] = []
  const entries: Tab[] = []
  let createdAt = 1_700_000_000_000
  for (const group of groups) {
    group.tabs.forEach((spec, index) => {
      createdAt += 1000
      const common = {
        groupId: group.id,
        worktreeId: key,
        executionHostId: hostId,
        sortOrder: index,
        createdAt,
        customLabel: null,
        color: null
      }
      if (!isTerminal(spec)) {
        const entityId = spec.entityId ?? spec.id
        entries.push({
          id: spec.id,
          entityId,
          contentType: spec.kind,
          label: entityId,
          ...common,
          ...spec.entry
        })
        return
      }
      const title = spec.title ?? `Terminal ${rows.length + 1}`
      const entityId = spec.entityId ?? spec.id
      rows.push({
        id: entityId,
        ptyId: spec.leaves.find(([, ptyId]) => ptyId)?.[1] ?? null,
        worktreeId: key,
        title,
        defaultTitle: title,
        customTitle: null,
        color: null,
        sortOrder: rows.length,
        createdAt,
        ...spec.row
      })
      entries.push({
        id: spec.id,
        entityId,
        contentType: 'terminal',
        label: title,
        ...common,
        ...spec.entry
      })
      const bindings = spec.leaves.flatMap(([leafId, ptyId]) => (ptyId ? [[leafId, ptyId]] : []))
      session.terminalLayoutsByTabId[entityId] = {
        root: paneTree(
          spec.leaves.map(([leafId]) => leafId),
          spec.split ?? 'vertical'
        ),
        activeLeafId: spec.leaves[0]![0],
        expandedLeafId: null,
        ptyIdsByLeafId: Object.fromEntries(bindings),
        ...spec.layout
      }
    })
  }
  const tabGroups: TabGroup[] = groups.map((group) => ({
    id: group.id,
    worktreeId: key,
    activeTabId: group.activeTabId === undefined ? (group.tabs[0]?.id ?? null) : group.activeTabId,
    tabOrder: group.tabs.map((tab) => tab.id),
    ...(group.recent ? { recentTabIds: group.recent } : {})
  }))
  session.tabsByWorktree[key] = rows
  session.unifiedTabs = { ...session.unifiedTabs, [key]: entries }
  session.tabGroups = { ...session.tabGroups, [key]: tabGroups }
  session.tabGroupLayouts = {
    ...session.tabGroupLayouts,
    [key]:
      groups.length === 1
        ? { type: 'leaf', groupId: groups[0]!.id }
        : {
            type: 'split',
            direction: 'horizontal',
            ratio: 0.6,
            first: { type: 'leaf', groupId: groups[0]!.id },
            second: { type: 'leaf', groupId: groups[1]!.id }
          }
  }
  session.activeGroupIdByWorktree = { ...session.activeGroupIdByWorktree, [key]: groups[0]!.id }
  session.activeTabIdByWorktree = { ...session.activeTabIdByWorktree, [key]: rows[0]?.id ?? null }
  return session
}

export function emptySession(): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    unifiedTabs: {},
    tabGroups: {},
    tabGroupLayouts: {},
    activeGroupIdByWorktree: {}
  }
}
