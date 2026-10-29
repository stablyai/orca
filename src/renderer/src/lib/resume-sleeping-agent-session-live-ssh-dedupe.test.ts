import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { useAppStore } from '@/store'
import { makeWorktree, TEST_REPO } from '../store/slices/worktrees-slice-test-fixtures'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'

// Main's answer to the window's layout commands, as a switch-on build sends them.
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) =>
  (
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  ).runtimeRpcClientWithLayoutApply(await importOriginal())
)

const initialAppStoreState = useAppStore.getState()
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_LEAF_ID = '22222222-2222-4222-8222-222222222222'
const SSH_PTY_ID = 'ssh:ssh-target-1@@pty-3'

afterEach(() => {
  vi.unstubAllGlobals()
  useAppStore.setState(initialAppStoreState, true)
})

function setStoreState(partial: Record<string, unknown>): void {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixtures set only the slices the wake sweep reads; the rest stay at the real initial state.
  useAppStore.setState(partial as Partial<ReturnType<typeof useAppStore.getState>>)
}

function makeRecord(
  overrides: Partial<SleepingAgentSessionRecord> = {}
): SleepingAgentSessionRecord {
  return {
    paneKey: makePaneKey('tab-1', LEAF_ID),
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'sess-1' },
    prompt: 'finish the task',
    state: 'working',
    origin: 'quit',
    capturedAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

function makeTerminalTab(id: string, worktreeId: string): Record<string, unknown> {
  return {
    id,
    ptyId: null,
    worktreeId,
    title: 'shell',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 1
  }
}

function makeLayout(leafId: string, ptyId: string | null): Record<string, unknown> {
  return {
    root: { type: 'leaf', leafId },
    activeLeafId: leafId,
    expandedLeafId: null,
    ptyIdsByLeafId: ptyId ? { [leafId]: ptyId } : {}
  }
}

describe('resumeSleepingAgentSessionsForWorktree — SSH panes and stale worktree ids', () => {
  it('treats a leaf bound to an ssh pty as pane-owned while its target is disconnected', () => {
    const record = makeRecord()
    setStoreState({
      activeWorktreeId: 'wt-other',
      tabsByWorktree: { 'wt-1': [makeTerminalTab('tab-1', 'wt-1')] },
      terminalLayoutsByTabId: { 'tab-1': makeLayout(LEAF_ID, SSH_PTY_ID) },
      ptyIdsByTabId: {},
      sshConnectionStates: new Map([['ssh-target-1', { status: 'disconnected' }]]),
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    })

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    expect(launched).toBe(0)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
  })

  it('resumes a leaf whose ssh pty is gone while its target is connected', () => {
    const record = makeRecord({ origin: 'quit' })
    setStoreState({
      activeWorktreeId: 'wt-other',
      tabsByWorktree: { 'wt-1': [makeTerminalTab('tab-1', 'wt-1')] },
      terminalLayoutsByTabId: { 'tab-1': makeLayout(LEAF_ID, SSH_PTY_ID) },
      ptyIdsByTabId: {},
      sshConnectionStates: new Map([['ssh-target-1', { status: 'connected' }]]),
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    })

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    expect(launched).toBe(1)
  })

  it("does not credit a split leaf with another leaf's ssh pty", () => {
    const record = makeRecord()
    setStoreState({
      activeWorktreeId: 'wt-other',
      tabsByWorktree: { 'wt-1': [{ ...makeTerminalTab('tab-1', 'wt-1'), ptyId: SSH_PTY_ID }] },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: {
            type: 'split',
            direction: 'vertical',
            first: { type: 'leaf', leafId: OTHER_LEAF_ID },
            second: { type: 'leaf', leafId: LEAF_ID }
          },
          activeLeafId: OTHER_LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: {}
        }
      },
      ptyIdsByTabId: {},
      sshConnectionStates: new Map([['ssh-target-1', { status: 'disconnected' }]]),
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    })

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    expect(launched).toBe(1)
  })

  it('still resumes when the preserved pane has no pty binding and cannot own recovery', () => {
    const record = makeRecord()
    setStoreState({
      activeWorktreeId: 'wt-other',
      tabsByWorktree: { 'wt-1': [makeTerminalTab('tab-1', 'wt-1')] },
      terminalLayoutsByTabId: { 'tab-1': makeLayout(LEAF_ID, null) },
      ptyIdsByTabId: {},
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    })

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    expect(launched).toBe(1)
  })

  it('finds the preserved tab when the record worktreeId is stale', () => {
    const record = makeRecord()
    setStoreState({
      activeWorktreeId: 'wt-other',
      tabsByWorktree: { 'wt-1': [], 'wt-2': [makeTerminalTab('tab-1', 'wt-2')] },
      terminalLayoutsByTabId: { 'tab-1': makeLayout(LEAF_ID, SSH_PTY_ID) },
      ptyIdsByTabId: {},
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    })

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    expect(launched).toBe(0)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
  })

  it('clears a record whose provider session is owned by a record in another worktree', () => {
    const stale = makeRecord({ providerSession: { key: 'session_id', id: 'sess-9' } })
    const owned = makeRecord({
      paneKey: makePaneKey('tab-2', OTHER_LEAF_ID),
      tabId: 'tab-2',
      worktreeId: 'wt-2',
      providerSession: { key: 'session_id', id: 'sess-9' }
    })
    setStoreState({
      activeWorktreeId: 'wt-other',
      tabsByWorktree: { 'wt-1': [], 'wt-2': [makeTerminalTab('tab-2', 'wt-2')] },
      terminalLayoutsByTabId: { 'tab-2': makeLayout(OTHER_LEAF_ID, SSH_PTY_ID) },
      ptyIdsByTabId: {},
      sleepingAgentSessionsByPaneKey: { [stale.paneKey]: stale, [owned.paneKey]: owned }
    })

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    expect(launched).toBe(0)
    const records = useAppStore.getState().sleepingAgentSessionsByPaneKey
    expect(records[stale.paneKey]).toBeUndefined()
    expect(records[owned.paneKey]).toBe(owned)
  })

  // A host-moved claimant cannot resume; accepting it would delete the only usable record.
  it('ignores a claim from a record whose worktree now routes to another host', () => {
    const remotePath = '/home/neil/projects/wt-2'
    const remoteWorktreeId = `repo-2::${remotePath}`
    const local = makeRecord({ providerSession: { key: 'session_id', id: 'sess-9' } })
    const moved = makeRecord({
      paneKey: makePaneKey('tab-2', OTHER_LEAF_ID),
      tabId: 'tab-2',
      worktreeId: remoteWorktreeId,
      connectionId: null,
      providerSession: { key: 'session_id', id: 'sess-9' }
    })
    setStoreState({
      activeWorktreeId: 'wt-other',
      repos: [
        { ...TEST_REPO, id: 'repo-2', path: '/home/neil/projects', connectionId: 'ssh-target-1' }
      ],
      worktreesByRepo: {
        'repo-2': [
          makeWorktree({
            id: remoteWorktreeId,
            repoId: 'repo-2',
            path: remotePath,
            hostId: 'ssh:ssh-target-1'
          })
        ]
      },
      tabsByWorktree: {
        'wt-1': [],
        [remoteWorktreeId]: [makeTerminalTab('tab-2', remoteWorktreeId)]
      },
      terminalLayoutsByTabId: { 'tab-2': makeLayout(OTHER_LEAF_ID, SSH_PTY_ID) },
      ptyIdsByTabId: {},
      sleepingAgentSessionsByPaneKey: { [local.paneKey]: local, [moved.paneKey]: moved }
    })

    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(1)
  })

  it('ignores a claim from a folder workspace whose host moved since capture', () => {
    const folderWorkspaceId = 'folder:fw-1'
    const local = makeRecord({ providerSession: { key: 'session_id', id: 'sess-9' } })
    const moved = makeRecord({
      paneKey: makePaneKey('tab-2', OTHER_LEAF_ID),
      tabId: 'tab-2',
      worktreeId: folderWorkspaceId,
      connectionId: null,
      providerSession: { key: 'session_id', id: 'sess-9' }
    })
    setStoreState({
      activeWorktreeId: 'wt-other',
      folderWorkspaces: [{ id: 'fw-1', connectionId: 'ssh-target-1', diffComments: [] }],
      tabsByWorktree: {
        'wt-1': [],
        [folderWorkspaceId]: [makeTerminalTab('tab-2', folderWorkspaceId)]
      },
      terminalLayoutsByTabId: { 'tab-2': makeLayout(OTHER_LEAF_ID, SSH_PTY_ID) },
      ptyIdsByTabId: {},
      sleepingAgentSessionsByPaneKey: { [local.paneKey]: local, [moved.paneKey]: moved }
    })

    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(1)
  })

  // Copied IDs on two machines remain distinct sessions; owner catalog and capture stamp can independently name their machines.
  it('ignores a claim from a pane on a different machine than this record', () => {
    const localPath = '/Users/neil/projects/wt-1'
    const localWorktreeId = `repo-1::${localPath}`
    const local = makeRecord({
      paneKey: makePaneKey('tab-1', LEAF_ID),
      worktreeId: localWorktreeId,
      providerSession: { key: 'session_id', id: 'sess-9' }
    })
    const remote = makeRecord({
      paneKey: makePaneKey('tab-2', OTHER_LEAF_ID),
      tabId: 'tab-2',
      worktreeId: 'wt-2',
      connectionId: 'ssh-target-1',
      providerSession: { key: 'session_id', id: 'sess-9' }
    })
    setStoreState({
      activeWorktreeId: 'wt-other',
      tabsByWorktree: { [localWorktreeId]: [], 'wt-2': [makeTerminalTab('tab-2', 'wt-2')] },
      terminalLayoutsByTabId: { 'tab-2': makeLayout(OTHER_LEAF_ID, SSH_PTY_ID) },
      ptyIdsByTabId: {},
      repos: [{ ...TEST_REPO, id: 'repo-1', path: '/Users/neil/projects' }],
      worktreesByRepo: {
        'repo-1': [
          makeWorktree({ id: localWorktreeId, repoId: 'repo-1', path: localPath, hostId: 'local' })
        ]
      },
      sleepingAgentSessionsByPaneKey: { [local.paneKey]: local, [remote.paneKey]: remote }
    })

    expect(resumeSleepingAgentSessionsForWorktree(localWorktreeId)).toBe(1)
  })

  it('does not let a finished note in another worktree clear an active record', () => {
    const active = makeRecord({ providerSession: { key: 'session_id', id: 'sess-9' } })
    const finished = makeRecord({
      paneKey: makePaneKey('tab-2', OTHER_LEAF_ID),
      tabId: 'tab-2',
      worktreeId: 'wt-2',
      origin: 'live',
      state: 'done',
      providerSession: { key: 'session_id', id: 'sess-9' }
    })
    setStoreState({
      activeWorktreeId: 'wt-other',
      tabsByWorktree: { 'wt-1': [], 'wt-2': [makeTerminalTab('tab-2', 'wt-2')] },
      terminalLayoutsByTabId: { 'tab-2': makeLayout(OTHER_LEAF_ID, null) },
      ptyIdsByTabId: {},
      sleepingAgentSessionsByPaneKey: { [active.paneKey]: active, [finished.paneKey]: finished }
    })

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    expect(launched).toBe(1)
  })
})
