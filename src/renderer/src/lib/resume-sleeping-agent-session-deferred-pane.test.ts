import { afterEach, describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { clearPaneSpawnDeferral, setPaneSpawnDeferral } from './pane-spawn-deferral-registry'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'

const initialAppStoreState = useAppStore.getState()
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PANE_KEY = makePaneKey('tab-1', LEAF_ID)
const RESUME = { key: 'session_id', id: 'sess-deferred' } as const

afterEach(() => {
  clearPaneSpawnDeferral(PANE_KEY)
  useAppStore.setState(initialAppStoreState, true)
})

function deferredPaneState(): Partial<AppState> {
  const record: SleepingAgentSessionRecord = {
    paneKey: PANE_KEY,
    tabId: 'tab-1',
    worktreeId: 'wt-1',
    agent: 'claude',
    providerSession: RESUME,
    prompt: '',
    state: 'done',
    capturedAt: 1,
    updatedAt: 1,
    origin: 'quit',
    restoreOnTabOpenOnly: true
  }
  return {
    activeWorktreeId: 'wt-other',
    tabsByWorktree: {
      'wt-1': [
        {
          id: 'tab-1',
          ptyId: null,
          worktreeId: 'wt-1',
          title: 'claude',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ]
    },
    terminalLayoutsByTabId: {
      'tab-1': {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null
      }
    },
    // The wake path's own queued resume for this very tab.
    pendingStartupByTabId: {
      'tab-1': {
        command: "claude '--resume' 'sess-deferred'",
        launchAgent: 'claude',
        resumeProviderSession: RESUME
      }
    },
    sleepingAgentSessionsByPaneKey: { [PANE_KEY]: record }
  }
}

describe('wake sweep and a pane whose restore the host deferred', () => {
  it('neither launches nor clears the record the deferred pane will resume', () => {
    useAppStore.setState(deferredPaneState())
    setPaneSpawnDeferral(PANE_KEY, { reason: 'live_cap', resume: () => {} })

    expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(0)

    const state = useAppStore.getState()
    expect(state.tabsByWorktree['wt-1']).toHaveLength(1)
    expect(state.sleepingAgentSessionsByPaneKey[PANE_KEY]).toBeDefined()
  })
})
