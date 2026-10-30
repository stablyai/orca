import { describe, expect, it, vi } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import type { WslMovedProject } from '../../../../shared/wsl-move/wsl-moved-project'
import { fetchWorkspaceSessionWithRuntimeHostOwners } from '@/lib/workspace-session-host-hydration'
import { withoutWslMovedLocalRows, wslMovedSessionReadApi } from './wsl-moved-local-session-rows'

const HOST: ExecutionHostId = 'runtime:wsl%3AUbuntu'
const LOCAL_ID = 'repo-a::\\\\wsl.localhost\\Ubuntu\\home\\dev\\app'
const HOST_ID = 'repo-a::/home/dev/app'
const STAYING_ID = 'repo-b::C:\\src\\b'
const MOVED: WslMovedProject[] = [
  {
    kind: 'repo',
    id: 'repo-a',
    displayName: 'app',
    path: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\app',
    distro: 'Ubuntu'
  }
]

function terminal(id: string, worktreeId: string, title: string): TerminalTab {
  return {
    id,
    ptyId: null,
    worktreeId,
    title,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function tab(id: string, worktreeId: string, contentType: Tab['contentType']): Tab {
  return {
    id,
    entityId: id,
    groupId: 'group-1',
    worktreeId,
    contentType,
    label: id,
    customLabel: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function group(worktreeId: string, tabOrder: string[]): TabGroup {
  return { id: 'group-1', worktreeId, activeTabId: tabOrder[0] ?? null, tabOrder }
}

/** One workspace's terminal `tab-1` (titled by partition) plus any extra tab-bar tabs. */
function workspaceSession(
  worktreeId: string,
  title: string,
  extra: Tab[] = []
): WorkspaceSessionState {
  const tabs = [tab('tab-1', worktreeId, 'terminal'), ...extra]
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: { [worktreeId]: [terminal('tab-1', worktreeId, title)] },
    terminalLayoutsByTabId: {
      'tab-1': {
        root: { type: 'leaf', leafId: `${title}-leaf` },
        activeLeafId: `${title}-leaf`,
        expandedLeafId: null
      }
    },
    unifiedTabs: { [worktreeId]: tabs },
    tabGroups: {
      [worktreeId]: [
        group(
          worktreeId,
          tabs.map((entry) => entry.id)
        )
      ]
    },
    activeTabIdByWorktree: { [worktreeId]: 'tab-1' }
  }
}

function localPartition(): WorkspaceSessionState {
  const moved = workspaceSession(LOCAL_ID, 'local', [tab('chat-1', LOCAL_ID, 'agent-session')])
  const staying = workspaceSession(STAYING_ID, 'staying')
  return {
    ...moved,
    tabsByWorktree: {
      ...moved.tabsByWorktree,
      [STAYING_ID]: [terminal('tab-9', STAYING_ID, 'staying')]
    },
    terminalLayoutsByTabId: {
      ...moved.terminalLayoutsByTabId,
      'tab-9': staying.terminalLayoutsByTabId['tab-1']
    },
    unifiedTabs: { ...moved.unifiedTabs, [STAYING_ID]: [tab('tab-9', STAYING_ID, 'terminal')] },
    tabGroups: { ...moved.tabGroups, [STAYING_ID]: [group(STAYING_ID, ['tab-9'])] }
  }
}

describe('WSL moved local session rows', () => {
  it("keeps only a moved workspace's chats, and every other workspace whole", () => {
    const local = withoutWslMovedLocalRows(localPartition(), MOVED)

    expect(local.tabsByWorktree).toEqual({
      [STAYING_ID]: [terminal('tab-9', STAYING_ID, 'staying')]
    })
    expect(Object.keys(local.terminalLayoutsByTabId)).toEqual(['tab-9'])
    expect(local.unifiedTabs?.[LOCAL_ID]?.map((entry) => entry.id)).toEqual(['chat-1'])
    expect(local.tabGroups?.[LOCAL_ID]?.[0]).toMatchObject({
      tabOrder: ['chat-1'],
      activeTabId: 'chat-1'
    })
    expect(local.activeTabIdByWorktree?.[LOCAL_ID]).toBeUndefined()
    expect(local.unifiedTabs?.[STAYING_ID]?.map((entry) => entry.id)).toEqual(['tab-9'])
  })

  it('leaves the partition alone when nothing moved', () => {
    const local = localPartition()

    expect(withoutWslMovedLocalRows(local, [])).toBe(local)
  })

  it("hydrates one tab-1, the host's, when both partitions hold it; the local chat stays", async () => {
    const read = await fetchWorkspaceSessionWithRuntimeHostOwners(
      wslMovedSessionReadApi(MOVED, {
        get: vi.fn(async (hostId?: ExecutionHostId) =>
          hostId === HOST ? workspaceSession(HOST_ID, 'host') : localPartition()
        )
      }),
      [],
      [HOST]
    )
    const { session } = read

    expect(session.terminalLayoutsByTabId['tab-1']?.activeLeafId).toBe('host-leaf')
    expect(session.tabsByWorktree[HOST_ID]?.map((entry) => entry.title)).toEqual(['host'])
    expect(session.tabsByWorktree[LOCAL_ID]).toBeUndefined()
    const tabOneOwners = Object.entries(session.unifiedTabs ?? {}).flatMap(([owner, tabs]) =>
      tabs.some((entry) => entry.id === 'tab-1') ? [owner] : []
    )
    expect(tabOneOwners).toEqual([HOST_ID])
    expect(session.unifiedTabs?.[LOCAL_ID]?.map((entry) => entry.id)).toEqual(['chat-1'])
    expect(read.runtimeHostIdByWorkspaceSessionKey[HOST_ID]).toBe(HOST)
  })
})
