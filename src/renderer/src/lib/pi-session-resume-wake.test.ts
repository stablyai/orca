import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { TerminalTab } from '../../../shared/types'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { useAppStore } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'

const initialAppStoreState = useAppStore.getState()
const PI_TRANSCRIPT_PATH = join(tmpdir(), 'pi-session-1.jsonl')
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const OTHER_LEAF_ID = '22222222-2222-4222-8222-222222222222'

afterEach(() => {
  useAppStore.setState(initialAppStoreState, true)
})

describe('Pi session wake', () => {
  it('wakes a manually slept Pi session with its transcript identity', () => {
    const providerSession = {
      key: 'session_id' as const,
      id: 'pi-session-1',
      transcriptPath: PI_TRANSCRIPT_PATH
    }
    const record: SleepingAgentSessionRecord = {
      paneKey: 'tab-1:leaf-1',
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      agent: 'pi',
      providerSession,
      prompt: '',
      state: 'working',
      capturedAt: 1,
      updatedAt: 1,
      origin: 'worktree-sleep'
    }
    const tab: TerminalTab = {
      id: 'tab-1',
      ptyId: null,
      worktreeId: 'wt-1',
      title: 'shell',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    }
    useAppStore.setState({
      tabsByWorktree: { 'wt-1': [tab] },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    })

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    expect(launched).toBe(1)
    const state = useAppStore.getState()
    const resumedTab = state.tabsByWorktree['wt-1']?.find((candidate) => candidate.id !== tab.id)
    expect(resumedTab?.launchAgent).toBe('pi')
    expect(state.pendingStartupByTabId[resumedTab!.id]?.resumeProviderSession).toEqual(
      providerSession
    )
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBeUndefined()
  })

  it('keeps a live Pi session in its hidden pane when the exact PTY is still alive', () => {
    const paneKey = makePaneKey('tab-1', LEAF_ID)
    const providerSession = {
      key: 'session_id' as const,
      id: 'pi-session-1',
      transcriptPath: PI_TRANSCRIPT_PATH
    }
    const record: SleepingAgentSessionRecord = {
      paneKey,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      agent: 'pi',
      providerSession,
      prompt: 'finish the task',
      state: 'working',
      capturedAt: 1,
      updatedAt: 1,
      origin: 'live'
    }
    const hiddenTab: TerminalTab = {
      id: 'tab-1',
      ptyId: null,
      worktreeId: 'wt-1',
      title: 'Pi ready',
      customTitle: null,
      color: null,
      sortOrder: 0,
      createdAt: 1
    }
    const activeTab: TerminalTab = {
      ...hiddenTab,
      id: 'tab-2',
      title: 'shell',
      sortOrder: 1
    }
    useAppStore.setState({
      activeWorktreeId: 'wt-1',
      activeTabType: 'terminal',
      activeTabId: 'tab-2',
      activeTabIdByWorktree: { 'wt-1': 'tab-2' },
      tabsByWorktree: { 'wt-1': [hiddenTab, activeTab] },
      ptyIdsByTabId: { 'tab-1': ['pty-1'], 'tab-2': ['pty-2'] },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: { type: 'leaf', leafId: LEAF_ID },
          activeLeafId: LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [LEAF_ID]: 'pty-1' }
        },
        'tab-2': {
          root: { type: 'leaf', leafId: OTHER_LEAF_ID },
          activeLeafId: OTHER_LEAF_ID,
          expandedLeafId: null,
          ptyIdsByLeafId: { [OTHER_LEAF_ID]: 'pty-2' }
        }
      },
      agentStatusByPaneKey: {
        [paneKey]: {
          paneKey,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          state: 'done',
          prompt: 'finish the task',
          updatedAt: 2,
          stateStartedAt: 2,
          agentType: 'pi',
          providerSession
        }
      },
      sleepingAgentSessionsByPaneKey: { [record.paneKey]: record }
    } as never)

    const launched = resumeSleepingAgentSessionsForWorktree('wt-1')

    const state = useAppStore.getState()
    expect(launched).toBe(0)
    expect(state.tabsByWorktree['wt-1']).toHaveLength(2)
    expect(state.pendingStartupByTabId).toEqual({})
    expect(state.sleepingAgentSessionsByPaneKey[record.paneKey]).toBe(record)
  })
})
