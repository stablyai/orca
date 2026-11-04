/** Direct SSH wake must wait for connection before declaring panes absent (STA-3500/3498 once forked five Claude writers). Paired-runtime web-terminal guards did not cover this path; retain records while unreachable and wake genuine sleepers after reconnect. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session/lifecycle/agent-session-resume'
import { useAppStore } from '@/store'
import { makeWorktree } from '../store/slices/worktrees-slice-test-fixtures'
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

describe('sleeping-agent resume across the direct-SSH hydration gap', () => {
  it('wakes the same session once its SSH target connects', () => {
    const record = seedColdDirectSshStart()
    resumeSleepingAgentSessionsForWorktree(WORKTREE_ID)

    useAppStore.getState().setSshConnectionState(TARGET_ID, {
      targetId: TARGET_ID,
      status: 'connected',
      error: null,
      reconnectAttempt: 0
    })
    const launched = resumeSleepingAgentSessionsForWorktree(WORKTREE_ID)

    expect(launched, 'the deferred agent never woke after the target connected').toBe(1)
    const state = useAppStore.getState()
    expect(state.tabsByWorktree[WORKTREE_ID]?.[0]?.launchAgent).toBe('claude')
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
  })
})
