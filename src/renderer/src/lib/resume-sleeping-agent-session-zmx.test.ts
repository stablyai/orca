import { afterEach, describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { toAppSshPtyId } from '../../../shared/ssh-pty-id'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { useAppStore } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'

const initialAppStoreState = useAppStore.getState()
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const WORKTREE_ID = 'wt-1'
const REMOTE_WORKTREE_ID = 'repo-1::/srv/atlas-eval'
const TARGET_ID = 'ssh-1'

afterEach(() => {
  useAppStore.setState(initialAppStoreState, true)
})

function makeRecord(): SleepingAgentSessionRecord {
  return {
    paneKey: makePaneKey('tab-1', LEAF_ID),
    tabId: 'tab-1',
    worktreeId: WORKTREE_ID,
    agent: 'codex',
    providerSession: { key: 'session_id', id: 'sess-1' },
    prompt: 'finish the task',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1,
    origin: 'quit',
    connectionId: TARGET_ID
  }
}

function makeTab(id: string, ptyId: string | null): Record<string, unknown> {
  return {
    id,
    ptyId,
    worktreeId: WORKTREE_ID,
    title: 'shell',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function makeLayout(leafId: string, ptyId: string): Record<string, unknown> {
  return {
    root: { type: 'leaf', leafId },
    activeLeafId: leafId,
    expandedLeafId: null,
    ptyIdsByLeafId: { [leafId]: ptyId }
  }
}

function seedInactivePane(options?: {
  ptyId?: string
  connectionId?: string | null
  activeWorktreeId?: string
}): SleepingAgentSessionRecord {
  const ptyId = options?.ptyId ?? toAppSshPtyId(TARGET_ID, 'pty-17')
  const record = {
    ...makeRecord(),
    connectionId: options?.connectionId === undefined ? TARGET_ID : options.connectionId
  }
  useAppStore.setState({
    activeWorktreeId: options?.activeWorktreeId ?? WORKTREE_ID,
    activeTabType: 'terminal',
    activeTabId: 'tab-2',
    activeTabIdByWorktree: { [WORKTREE_ID]: 'tab-2' },
    tabsByWorktree: {
      [WORKTREE_ID]: [makeTab('tab-1', ptyId), makeTab('tab-2', null)]
    },
    terminalLayoutsByTabId: {
      'tab-1': makeLayout(LEAF_ID, ptyId),
      'tab-2': makeLayout(OTHER_LEAF_ID, 'pty-2')
    },
    ptyIdsByTabId: {},
    sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
  } as never)
  return record
}

describe('SSH sleeping-agent recovery', () => {
  it('defers a global sleeping record until the SSH host snapshot restores its pane', () => {
    const record = {
      ...makeRecord(),
      worktreeId: REMOTE_WORKTREE_ID,
      connectionId: undefined
    }
    useAppStore.setState({
      repos: [
        {
          id: 'repo-1',
          path: '/srv/repo',
          displayName: 'repo',
          badgeColor: '#000000',
          addedAt: 1,
          connectionId: TARGET_ID
        }
      ],
      tabsByWorktree: { [REMOTE_WORKTREE_ID]: [] },
      remoteWorkspaceHydratedTargetIds: new Set(),
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    expect(resumeSleepingAgentSessionsForWorktree(REMOTE_WORKTREE_ID)).toBe(0)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)

    const ptyId = toAppSshPtyId(TARGET_ID, 'pty-17')
    useAppStore.setState({
      tabsByWorktree: { [REMOTE_WORKTREE_ID]: [makeTab('tab-1', ptyId)] },
      terminalLayoutsByTabId: { 'tab-1': makeLayout(LEAF_ID, ptyId) },
      remoteWorkspaceHydratedTargetIds: new Set([TARGET_ID])
    } as never)

    expect(resumeSleepingAgentSessionsForWorktree(REMOTE_WORKTREE_ID)).toBe(0)
    expect(useAppStore.getState().tabsByWorktree[REMOTE_WORKTREE_ID]).toHaveLength(1)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
  })

  it('cold-resumes a stranded record once the snapshot is authoritative and no pane survives', () => {
    // Why: after hydration, a record with no owning pane can only recover here;
    // deferring it forever would strand it (never resumed, never cleaned).
    const record = { ...makeRecord(), worktreeId: REMOTE_WORKTREE_ID, connectionId: undefined }
    useAppStore.setState({
      repos: [
        {
          id: 'repo-1',
          path: '/srv/repo',
          displayName: 'repo',
          badgeColor: '#000000',
          addedAt: 1,
          connectionId: TARGET_ID
        }
      ],
      tabsByWorktree: { [REMOTE_WORKTREE_ID]: [] },
      remoteWorkspaceHydratedTargetIds: new Set([TARGET_ID]),
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    expect(resumeSleepingAgentSessionsForWorktree(REMOTE_WORKTREE_ID)).toBe(1)
    const state = useAppStore.getState()
    const resumedTab = state.tabsByWorktree[REMOTE_WORKTREE_ID]?.[0]
    expect(resumedTab?.launchAgent).toBe('codex')
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
  })

  it('uses the active SSH host before the remote repo catalog is hydrated', () => {
    const record = { ...makeRecord(), worktreeId: REMOTE_WORKTREE_ID, connectionId: undefined }
    useAppStore.setState({
      repos: [],
      worktreesByRepo: {},
      activeWorktreeId: REMOTE_WORKTREE_ID,
      activeWorkspaceKey: `worktree:${REMOTE_WORKTREE_ID}`,
      activeWorkspaceExecutionHostId: `ssh:${TARGET_ID}`,
      tabsByWorktree: { [REMOTE_WORKTREE_ID]: [] },
      remoteWorkspaceHydratedTargetIds: new Set(),
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    expect(resumeSleepingAgentSessionsForWorktree(REMOTE_WORKTREE_ID)).toBe(0)
    expect(useAppStore.getState().tabsByWorktree[REMOTE_WORKTREE_ID]).toEqual([])
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
  })

  it('keeps an inactive preserved SSH pane for authoritative in-place reattach', () => {
    const record = seedInactivePane()

    const launched = resumeSleepingAgentSessionsForWorktree(WORKTREE_ID)

    const state = useAppStore.getState()
    expect(launched).toBe(0)
    expect(state.tabsByWorktree[WORKTREE_ID]).toHaveLength(2)
    expect(state.pendingStartupByTabId).toEqual({})
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
  })

  it('keeps an inactive non-SSH pane of the active worktree for in-place cold restore', () => {
    // Why: keep-alive mounts every tab of the active worktree (#12574), so the
    // hidden pane consumes the record itself instead of forking a resume tab.
    const record = seedInactivePane({ ptyId: 'pty-local', connectionId: null })

    const launched = resumeSleepingAgentSessionsForWorktree(WORKTREE_ID)

    const state = useAppStore.getState()
    expect(launched).toBe(0)
    expect(state.tabsByWorktree[WORKTREE_ID]).toHaveLength(2)
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
  })

  it('cold-resumes an inactive non-SSH pane on background wake', () => {
    const record = seedInactivePane({
      ptyId: 'pty-local',
      connectionId: null,
      activeWorktreeId: 'other-wt'
    })

    const launched = resumeSleepingAgentSessionsForWorktree(WORKTREE_ID)

    const state = useAppStore.getState()
    const resumedTab = state.tabsByWorktree[WORKTREE_ID]?.find(
      (tab) => tab.id !== 'tab-1' && tab.id !== 'tab-2'
    )
    expect(launched).toBe(1)
    expect(resumedTab?.launchAgent).toBe('codex')
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
  })

  it('suppresses background wake for a zmx-preserved SSH pane', () => {
    // Why: the durable PTY still owns the agent; a background resume tab would
    // duplicate the live session.
    const record = seedInactivePane({ activeWorktreeId: 'other-wt' })

    const launched = resumeSleepingAgentSessionsForWorktree(WORKTREE_ID)

    const state = useAppStore.getState()
    expect(launched).toBe(0)
    expect(state.tabsByWorktree[WORKTREE_ID]).toHaveLength(2)
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
  })
})
