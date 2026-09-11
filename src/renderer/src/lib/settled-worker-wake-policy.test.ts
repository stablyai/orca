import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { resumeSleepingAgentSessionsForWorktree } from './resume-sleeping-agent-session'

const initialState = useAppStore.getState()

afterEach(() => {
  vi.unstubAllGlobals()
  useAppStore.setState(initialState, true)
})

it('resumes a settled worker and an ordinary agent once each in the same wake sweep', () => {
  const records = ['settled-worker', 'ordinary-agent'].map((id) => ({
    paneKey: `${id}:leaf`,
    tabId: id,
    worktreeId: 'wt-1',
    agent: 'claude' as const,
    providerSession: { key: 'session_id' as const, id },
    prompt: 'continue the session',
    state: 'working' as const,
    capturedAt: Date.now(),
    updatedAt: Date.now(),
    origin: 'worktree-sleep' as const,
    // Old clients can still publish the withdrawn policy field.
    ...(id === 'settled-worker' ? { automaticResumeBlockedBy: 'legacy-orchestration-worker' } : {})
  }))
  useAppStore.setState({
    tabsByWorktree: { 'wt-1': [] },
    sleepingAgentSessionsByPaneKey: Object.fromEntries(records.map((r) => [r.paneKey, r]))
  })

  expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(2)
  expect(resumeSleepingAgentSessionsForWorktree('wt-1')).toBe(0)
  const state = useAppStore.getState()
  const tabs = state.tabsByWorktree['wt-1']
  expect(tabs).toHaveLength(2)
  const commands = tabs.map((tab) => state.pendingStartupByTabId[tab.id]?.command ?? '')
  for (const record of records) {
    expect(commands.filter((command) => command.includes(record.providerSession.id))).toHaveLength(
      1
    )
  }
  for (const command of commands) {
    expect(command.match(/--resume/g)).toHaveLength(1)
  }
  expect(state.sleepingAgentSessionsByPaneKey).toEqual({})
})
