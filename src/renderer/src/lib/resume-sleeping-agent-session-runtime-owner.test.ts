import { afterEach, describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  toSshExecutionHostId
} from '../../../shared/execution-host'
import { useAppStore } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'

const initialAppStoreState = useAppStore.getState()
// A runtime env focused globally that is NOT any worktree's explicit owner, so a
// gate can only fire from a worktree's own runtime ownership, never global focus.
const GLOBAL_FOCUSED_ENV = 'env-global'

afterEach(() => {
  useAppStore.setState(initialAppStoreState, true)
})

function makeLiveRecord(worktreeId: string, tabId: string): SleepingAgentSessionRecord {
  return {
    paneKey: `${tabId}:leaf-1`,
    tabId,
    worktreeId,
    agent: 'claude',
    providerSession: { key: 'session_id', id: `sess-${worktreeId}` },
    prompt: 'finish the task',
    state: 'working',
    origin: 'live',
    capturedAt: 1,
    updatedAt: 1
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

type WorktreeOwner =
  | { via: 'worktreeHost'; hostId: string }
  | { via: 'repoHost'; executionHostId: string }

function worktreeRow(id: string, repoId: string, owner: WorktreeOwner): Record<string, unknown> {
  return {
    id,
    repoId,
    // path feeds the WSL/remote launch checks during resume; the gate itself
    // only reads hostId. A defined path keeps createTab from dereferencing undefined.
    path: `/repo/${id}`,
    ...(owner.via === 'worktreeHost' ? { hostId: owner.hostId } : {})
  }
}

// Installs the target worktree (with its explicit owner) alongside a runtime-owned
// sibling, both carrying a live record, while a different runtime env is globally
// focused. Exercises the explicit per-worktree/per-repo owner branch of
// getRuntimeEnvironmentIdForWorktree, not just the global fallback.
function installState(targetOwner: WorktreeOwner): {
  targetRecord: SleepingAgentSessionRecord
  siblingRecord: SleepingAgentSessionRecord
} {
  const targetRecord = makeLiveRecord('wt-target', 'tab-target')
  const siblingRecord = makeLiveRecord('wt-sibling', 'tab-sibling')
  const repos =
    targetOwner.via === 'repoHost'
      ? [{ id: 'repo-target', executionHostId: targetOwner.executionHostId }]
      : []
  useAppStore.setState({
    settings: { ...initialAppStoreState.settings, activeRuntimeEnvironmentId: GLOBAL_FOCUSED_ENV },
    repos,
    worktreesByRepo: {
      'repo-target': [worktreeRow('wt-target', 'repo-target', targetOwner)],
      'repo-sibling': [
        worktreeRow('wt-sibling', 'repo-sibling', {
          via: 'worktreeHost',
          hostId: toRuntimeExecutionHostId('env-sibling')
        })
      ]
    },
    tabsByWorktree: {
      'wt-target': [makeTerminalTab('tab-target', 'wt-target')],
      'wt-sibling': [makeTerminalTab('tab-sibling', 'wt-sibling')]
    },
    sleepingAgentSessionsByPaneKey: {
      [targetRecord.paneKey]: targetRecord,
      [siblingRecord.paneKey]: siblingRecord
    }
  } as never)
  return { targetRecord, siblingRecord }
}

const cases: { name: string; owner: WorktreeOwner; expectedLaunched: number }[] = [
  {
    name: 'explicit runtime-owned worktree host is gated',
    owner: { via: 'worktreeHost', hostId: toRuntimeExecutionHostId('env-1') },
    expectedLaunched: 0
  },
  {
    name: 'explicit runtime-owned repo host is gated',
    owner: { via: 'repoHost', executionHostId: toRuntimeExecutionHostId('env-2') },
    expectedLaunched: 0
  },
  {
    name: 'explicit local worktree host still resumes',
    owner: { via: 'worktreeHost', hostId: LOCAL_EXECUTION_HOST_ID },
    expectedLaunched: 1
  },
  {
    name: 'explicit ssh worktree host still resumes',
    owner: { via: 'worktreeHost', hostId: toSshExecutionHostId('my-server') },
    expectedLaunched: 1
  },
  {
    name: 'explicit local repo host (forced WSL) still resumes',
    owner: { via: 'repoHost', executionHostId: LOCAL_EXECUTION_HOST_ID },
    expectedLaunched: 1
  }
]

describe('resumeSleepingAgentSessionsForWorktree runtime-owner gate', () => {
  it.each(cases)(
    '$name while a different runtime env is globally focused',
    ({ owner, expectedLaunched }) => {
      const { targetRecord, siblingRecord } = installState(owner)

      const launched = resumeSleepingAgentSessionsForWorktree('wt-target')

      const state = useAppStore.getState()
      expect(launched).toBe(expectedLaunched)
      if (expectedLaunched === 0) {
        expect(state.tabsByWorktree['wt-target']).toHaveLength(1)
        expect(state.pendingStartupByTabId).toEqual({})
        expect(state.sleepingAgentSessionsByPaneKey[targetRecord.paneKey]).toBe(targetRecord)
      } else {
        const resumedTab = state.tabsByWorktree['wt-target']?.find((tab) => tab.id !== 'tab-target')
        expect(resumedTab?.launchAgent).toBe('claude')
        expect(state.sleepingAgentSessionsByPaneKey[targetRecord.paneKey]).toBeUndefined()
      }
      // The runtime-owned sibling is never touched: the gate keys off the requested
      // worktree's own ownership, not whichever runtime is globally focused.
      expect(state.tabsByWorktree['wt-sibling']).toHaveLength(1)
      expect(state.sleepingAgentSessionsByPaneKey[siblingRecord.paneKey]).toBe(siblingRecord)
    }
  )

  it('gates only the runtime-owned worktree when a local sibling shares the store', () => {
    const { targetRecord: localRecord, siblingRecord: runtimeRecord } = installState({
      via: 'worktreeHost',
      hostId: LOCAL_EXECUTION_HOST_ID
    })

    const runtimeLaunched = resumeSleepingAgentSessionsForWorktree('wt-sibling')
    const localLaunched = resumeSleepingAgentSessionsForWorktree('wt-target')

    const state = useAppStore.getState()
    expect(runtimeLaunched).toBe(0)
    expect(localLaunched).toBe(1)
    expect(state.sleepingAgentSessionsByPaneKey[runtimeRecord.paneKey]).toBe(runtimeRecord)
    expect(state.tabsByWorktree['wt-sibling']).toHaveLength(1)
    expect(state.sleepingAgentSessionsByPaneKey[localRecord.paneKey]).toBeUndefined()
    const resumedLocalTab = state.tabsByWorktree['wt-target']?.find((tab) => tab.id !== 'tab-target')
    expect(resumedLocalTab?.launchAgent).toBe('claude')
  })

  it('leaves the sleeping record present and unmodified when the gate skips resume', () => {
    const { targetRecord } = installState({
      via: 'worktreeHost',
      hostId: toRuntimeExecutionHostId('env-1')
    })
    const recordSnapshot = JSON.parse(JSON.stringify(targetRecord))

    const launched = resumeSleepingAgentSessionsForWorktree('wt-target')

    const gatedState = useAppStore.getState()
    expect(launched).toBe(0)
    const preserved = gatedState.sleepingAgentSessionsByPaneKey[targetRecord.paneKey]
    // The gate is non-destructive: it must not consume or mutate the record, only
    // decline to launch. Retirement policy is the deferred follow-up (#8878).
    expect(preserved).toBe(targetRecord)
    expect(preserved).toEqual(recordSnapshot)

    // The preserved record stays resumable once the worktree is no longer
    // runtime-owned (ownership legitimately moving back to this client).
    useAppStore.setState({
      worktreesByRepo: {
        ...gatedState.worktreesByRepo,
        'repo-target': [
          worktreeRow('wt-target', 'repo-target', {
            via: 'worktreeHost',
            hostId: LOCAL_EXECUTION_HOST_ID
          })
        ]
      }
    } as never)
    expect(resumeSleepingAgentSessionsForWorktree('wt-target')).toBe(1)
    expect(
      useAppStore.getState().sleepingAgentSessionsByPaneKey[targetRecord.paneKey]
    ).toBeUndefined()
  })
})
