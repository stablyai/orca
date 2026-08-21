import { afterEach, describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import { useAppStore } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'

const initialAppStoreState = useAppStore.getState()
const LEAF_ID = '11111111-1111-1111-8111-111111111111'
const PANE_KEY = `pi-tab:${LEAF_ID}`

afterEach(() => {
  useAppStore.setState(initialAppStoreState, true)
})

describe('Pi live session does not spawn a duplicate resume tab', () => {
  it('keeps a done-but-alive Pi pane instead of forking a new tab', () => {
    const providerSession = {
      key: 'session_id' as const,
      id: 'pi-1',
      transcriptPath: '/tmp/pi-session-1.jsonl'
    }
    const record: SleepingAgentSessionRecord = {
      paneKey: PANE_KEY,
      tabId: 'pi-tab',
      worktreeId: 'wt-1',
      agent: 'pi',
      providerSession,
      prompt: '',
      state: 'working',
      capturedAt: 1,
      updatedAt: 1,
      origin: 'live'
    }
    useAppStore.setState({
      activeWorktreeId: 'wt-1',
      activeTabType: 'editor',
      activeTabId: null,
      tabsByWorktree: {
        'wt-1': [
          {
            id: 'pi-tab',
            ptyId: 'pty-1',
            worktreeId: 'wt-1',
            title: 'pi',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1
          }
        ]
      },
      ptyIdsByTabId: { 'pi-tab': ['pty-1'] },
      terminalLayoutsByTabId: {
        'pi-tab': {
          root: { type: 'leaf', leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_ID]: 'pty-1' }
        }
      },
      agentStatusByPaneKey: {
        [PANE_KEY]: {
          state: 'done',
          prompt: '',
          updatedAt: 10,
          stateStartedAt: 10,
          agentType: 'pi',
          paneKey: PANE_KEY,
          worktreeId: 'wt-1',
          tabId: 'pi-tab',
          providerSession
        }
      },
      sleepingAgentSessionsByPaneKey: { [PANE_KEY]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    expect(launched).toBe(0)
    expect(useAppStore.getState().tabsByWorktree['wt-1']).toHaveLength(1)
    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey[PANE_KEY]).toBe(record)
  })
})
