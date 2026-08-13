import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../shared/agent-status-types'
import { shouldOpenBrowserBesideLiveAgent } from './browser-open-beside-live-agent'

function liveEntry(
  overrides: Partial<AgentStatusEntry> & Pick<AgentStatusEntry, 'paneKey'>
): AgentStatusEntry {
  return {
    state: 'working',
    prompt: 'review UI',
    updatedAt: 1,
    stateStartedAt: 1,
    stateHistory: [],
    ...overrides
  }
}

describe('shouldOpenBrowserBesideLiveAgent', () => {
  it('returns false when the worktree is not active', () => {
    expect(
      shouldOpenBrowserBesideLiveAgent(
        {
          activeWorktreeId: 'wt-other',
          activeTabType: 'terminal',
          agentStatusByPaneKey: {
            'tab-1:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee': liveEntry({
              paneKey: 'tab-1:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
              tabId: 'tab-1',
              worktreeId: 'wt-1'
            })
          },
          tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] }
        },
        'wt-1'
      )
    ).toBe(false)
  })

  it('returns false when the active surface is already browser', () => {
    expect(
      shouldOpenBrowserBesideLiveAgent(
        {
          activeWorktreeId: 'wt-1',
          activeTabType: 'browser',
          agentStatusByPaneKey: {
            'tab-1:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee': liveEntry({
              paneKey: 'tab-1:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
              tabId: 'tab-1',
              worktreeId: 'wt-1'
            })
          },
          tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] }
        },
        'wt-1'
      )
    ).toBe(false)
  })

  it('returns true when a live agent terminal is on the active worktree surface', () => {
    expect(
      shouldOpenBrowserBesideLiveAgent(
        {
          activeWorktreeId: 'wt-1',
          activeTabType: 'terminal',
          agentStatusByPaneKey: {
            'tab-1:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee': liveEntry({
              paneKey: 'tab-1:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
              tabId: 'tab-1',
              worktreeId: 'wt-1'
            })
          },
          tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] }
        },
        'wt-1'
      )
    ).toBe(true)
  })

  it('returns false when agents are done', () => {
    expect(
      shouldOpenBrowserBesideLiveAgent(
        {
          activeWorktreeId: 'wt-1',
          activeTabType: 'terminal',
          agentStatusByPaneKey: {
            'tab-1:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee': liveEntry({
              paneKey: 'tab-1:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
              tabId: 'tab-1',
              worktreeId: 'wt-1',
              state: 'done'
            })
          },
          tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] }
        },
        'wt-1'
      )
    ).toBe(false)
  })

  it('returns false when the live agent belongs to another worktree', () => {
    expect(
      shouldOpenBrowserBesideLiveAgent(
        {
          activeWorktreeId: 'wt-1',
          activeTabType: 'terminal',
          agentStatusByPaneKey: {
            'tab-2:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee': liveEntry({
              paneKey: 'tab-2:aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
              tabId: 'tab-2',
              worktreeId: 'wt-2'
            })
          },
          tabsByWorktree: { 'wt-1': [{ id: 'tab-1' }] }
        },
        'wt-1'
      )
    ).toBe(false)
  })
})
