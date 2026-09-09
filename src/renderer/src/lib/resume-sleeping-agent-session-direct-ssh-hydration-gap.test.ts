/**
 * STA-3500: a direct-SSH workspace's tab rows only reach the renderer after connect, via
 * remoteWorkspace.get → merge — a network round trip. The startup resume sweep fires before that
 * lands, sees no pane owning a sleeping record, and cold-resumes a session the host is still
 * running. STA-3498 counted five concurrent `claude` processes on one transcript that way.
 *
 * The paired-runtime flavor already parks per pane (host-mirrored-pane-liveness.ts), but that guard
 * only recognises `web-terminal-*` surface ids, so direct SSH fell straight through it.
 *
 * Both halves matter: the sweep must decline while the host is unanswered, and it must still wake a
 * genuinely sleeping agent once the host answers.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { useAppStore } from '@/store'
import { makeWorktree } from '@/store/slices/store-test-helpers'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'

const initialAppStoreState = useAppStore.getState()

const TARGET_ID = 'ssh-target-1'
const PATH = '/srv/proj/feature'
const WORKTREE_ID = `repoSsh::${PATH}`
const LOCAL_WORKTREE_ID = 'repoLocal::/home/dev/proj/feature'

afterEach(() => {
  vi.unstubAllGlobals()
  useAppStore.setState(initialAppStoreState, true)
})

function makeRecord(worktreeId: string): SleepingAgentSessionRecord {
  return {
    paneKey: 'tab-1:leaf-1',
    tabId: 'tab-1',
    worktreeId,
    agent: 'claude',
    providerSession: { key: 'session_id', id: 'sess-remote-1' },
    prompt: 'finish the migration',
    state: 'working',
    origin: 'quit',
    capturedAt: 1,
    updatedAt: 1
  }
}

/** A cold start: the catalog knows the SSH workspace, but no tab row has arrived for it yet. */
function seedColdDirectSshStart(): SleepingAgentSessionRecord {
  const record = makeRecord(WORKTREE_ID)
  useAppStore.setState({
    repos: [
      {
        id: 'repoSsh',
        path: '/srv/proj',
        displayName: 'Proj',
        badgeColor: '#000',
        addedAt: 0,
        connectionId: TARGET_ID
      },
      {
        id: 'repoLocal',
        path: '/home/dev/proj',
        displayName: 'Local',
        badgeColor: '#000',
        addedAt: 0
      }
    ],
    worktreesByRepo: {
      repoSsh: [
        makeWorktree({
          id: WORKTREE_ID,
          repoId: 'repoSsh',
          path: PATH,
          hostId: `ssh:${TARGET_ID}`
        } as never)
      ],
      repoLocal: [
        makeWorktree({
          id: LOCAL_WORKTREE_ID,
          repoId: 'repoLocal',
          path: '/home/dev/proj/feature',
          hostId: 'local'
        } as never)
      ]
    },
    tabsByWorktree: {},
    sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
  } as never)
  return record
}

function resumedTabCount(worktreeId: string): number {
  return (useAppStore.getState().tabsByWorktree[worktreeId] ?? []).length
}

describe('sleeping-agent resume across the direct-SSH hydration gap', () => {
  it('does not resume a remote session before the host has answered', () => {
    const record = seedColdDirectSshStart()

    const launched = resumeSleepingAgentSessionsForWorktree(WORKTREE_ID)

    expect(launched, 'cold-resumed a session the host may still be running').toBe(0)
    expect(resumedTabCount(WORKTREE_ID)).toBe(0)
    // Absence of evidence must not authorise deletion either — the record has to survive to wake later.
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
  })

  it('wakes the same session once the host answers and holds no pane for it', () => {
    const record = seedColdDirectSshStart()
    resumeSleepingAgentSessionsForWorktree(WORKTREE_ID)

    useAppStore.getState().markRemoteWorkspaceHydrated(TARGET_ID)
    const launched = resumeSleepingAgentSessionsForWorktree(WORKTREE_ID)

    expect(launched, 'the deferred agent never woke after the host answered').toBe(1)
    const state = useAppStore.getState()
    expect(state.tabsByWorktree[WORKTREE_ID]?.[0]?.launchAgent).toBe('claude')
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
  })

  it('leaves a purely local workspace resuming with no added latency', () => {
    seedColdDirectSshStart()
    const localRecord = {
      ...makeRecord(LOCAL_WORKTREE_ID),
      paneKey: 'tab-2:leaf-1',
      tabId: 'tab-2'
    }
    useAppStore.setState({
      sleepingAgentSessionsByPaneKey: { [localRecord.paneKey]: localRecord }
    } as never)

    // No hydration marked anywhere: a local workspace's host is this client, and it has answered.
    expect(resumeSleepingAgentSessionsForWorktree(LOCAL_WORKTREE_ID)).toBe(1)
    expect(resumedTabCount(LOCAL_WORKTREE_ID)).toBe(1)
  })
})
