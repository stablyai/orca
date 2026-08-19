import { afterEach, describe, expect, it } from 'vitest'
import { useAppStore } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from '@/lib/resume-sleeping-agent-session'

const initialAppStoreState = useAppStore.getState()

afterEach(() => {
  useAppStore.setState(initialAppStoreState, true)
})

const WT = 'wt-1'
const TAB = 'tab-1'
const PANE = `${TAB}:leaf-1`

function seedRunningAgentTab(): void {
  const now = Date.now()
  useAppStore.setState({
    workspaceSessionReady: true,
    hydrationSucceeded: true,
    tabsByWorktree: {
      [WT]: [{ id: TAB, ptyId: 'pty-1', worktreeId: WT, title: 'claude', sortOrder: 0, createdAt: 1 }]
    },
    ptyIdsByTabId: { [TAB]: ['pty-1'] },
    agentStatusByPaneKey: {
      [PANE]: {
        state: 'working',
        prompt: 'do a thing',
        updatedAt: now,
        stateStartedAt: now,
        agentType: 'claude',
        paneKey: PANE,
        worktreeId: WT,
        tabId: TAB,
        providerSession: { key: 'session_id', id: 'sess-1' }
      }
    }
  } as never)
  // The periodic checkpoint in App.tsx records every live agent so a hard kill can still resume it.
  useAppStore.getState().captureAllSleepingAgentSessions('periodic')
  expect(Object.keys(useAppStore.getState().sleepingAgentSessionsByPaneKey)).toEqual([PANE])
}

describe('closing a terminal tab retires its sleeping agent sessions', () => {
  it('drops the resume record when the shell exits (Ctrl+D), so activation cannot respawn the tab', () => {
    seedRunningAgentTab()

    useAppStore.getState().closeTab(TAB, { reason: 'pty-exit', retireSleepingAgentSessions: true })

    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey).toEqual({})
    expect(resumeSleepingAgentSessionsForWorktree(WT)).toBe(0)
    expect(useAppStore.getState().tabsByWorktree[WT] ?? []).toHaveLength(0)
  })

  it('drops the resume record on a user close', () => {
    seedRunningAgentTab()

    useAppStore.getState().closeTab(TAB)

    expect(useAppStore.getState().sleepingAgentSessionsByPaneKey).toEqual({})
    expect(resumeSleepingAgentSessionsForWorktree(WT)).toBe(0)
    expect(useAppStore.getState().tabsByWorktree[WT] ?? []).toHaveLength(0)
  })

  it('keeps the record when an unexpected PTY loss closed the tab', () => {
    seedRunningAgentTab()

    useAppStore.getState().closeTab(TAB, { reason: 'pty-exit' })

    expect(Object.keys(useAppStore.getState().sleepingAgentSessionsByPaneKey)).toEqual([PANE])
  })
})
