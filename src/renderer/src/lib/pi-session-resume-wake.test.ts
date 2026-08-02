import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../shared/agent-session-resume'
import type { TerminalTab } from '../../../shared/types'
import { useAppStore } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'

const initialAppStoreState = useAppStore.getState()
const PI_TRANSCRIPT_PATH = join(tmpdir(), 'pi-session-1.jsonl')

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
})
