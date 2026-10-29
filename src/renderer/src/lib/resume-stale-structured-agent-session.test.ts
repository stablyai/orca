import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { structuredAgentSessionTabId } from '../../../shared/structured-agent-session-projection'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'

const initialAppStoreState = useAppStore.getState()
const WORKTREE_ID = 'stale-structured-worktree'
const SESSION_ID = 'structured-session-stale'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'

afterEach(() => {
  useAppStore.setState(initialAppStoreState, true)
})

describe('stale structured sleeping session', () => {
  it('clears the synthetic terminal projection without spawning', () => {
    const tabId = structuredAgentSessionTabId(SESSION_ID)
    const paneKey = makePaneKey(tabId, LEAF_ID)
    const record: SleepingAgentSessionRecord = {
      paneKey,
      tabId,
      worktreeId: WORKTREE_ID,
      agent: 'codex',
      providerSession: { key: 'session_id', id: SESSION_ID },
      prompt: 'continue',
      state: 'working',
      capturedAt: 1,
      updatedAt: 1
    }
    useAppStore.setState({
      tabsByWorktree: { [WORKTREE_ID]: [] },
      sleepingAgentSessionsByPaneKey: { [paneKey]: record }
    } as never)

    expect(resumeSleepingAgentSessionsForWorktree(WORKTREE_ID)).toBe(0)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[paneKey]).toBeUndefined()
    expect(useAppStore.getState().pendingStartupByTabId).toEqual({})
  })
})
