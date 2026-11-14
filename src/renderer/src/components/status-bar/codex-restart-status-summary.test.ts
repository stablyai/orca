import { describe, expect, it } from 'vitest'
import {
  summarizeCodexRestartStatus,
  type CodexRestartStatusSummaryInput
} from './codex-restart-status-summary'
import type { CodexAccountRestart } from '@/store/terminals/terminal-contracts'

const leaf = '00000000-0000-4000-8000-000000000001'
const awaiting = { previousAccountLabel: 'old', nextAccountLabel: 'new' }
function population(): CodexRestartStatusSummaryInput {
  return {
    tabsByWorktree: {
      wt: [
        {
          id: 'tab',
          worktreeId: 'wt',
          createdAt: 1,
          ptyId: 'live',
          title: '',
          customTitle: null,
          color: null,
          sortOrder: 0
        }
      ]
    },
    terminalLayoutsByTabId: {
      tab: {
        root: { type: 'leaf', leafId: leaf },
        activeLeafId: leaf,
        expandedLeafId: null,
        ptyIdsByLeafId: { [leaf]: 'live' }
      }
    },
    ptyIdsByTabId: { tab: ['live'] },
    codexRestartNoticeByPtyId: { live: awaiting, orphan: awaiting },
    paneAccountRestarts: {}
  }
}
function failure(): CodexAccountRestart {
  return {
    agent: 'codex',
    requestId: 'request',
    attemptId: 'attempt',
    worktreeId: 'wt',
    tabId: 'tab',
    tabCreatedAt: 1,
    leafId: leaf,
    oldPtyId: 'live',
    hostId: 'local',
    environmentId: null,
    phase: 'failed',
    startupInput: null,
    startup: null
  }
}

describe('Codex restart attention population', () => {
  it('counts and queues only the current eligible notice in a mixed orphan population', () => {
    const result = summarizeCodexRestartStatus(population())
    expect(result.attentionCount).toBe(1)
    expect(result.stalePtyIds).toEqual(['live'])
  })
  it('counts a failed empty pane once, hides accepted delivery, and omits a successor or removed leaf', () => {
    const state = population()
    state.terminalLayoutsByTabId.tab.ptyIdsByLeafId = {}
    state.ptyIdsByTabId.tab = []
    state.paneAccountRestarts[`tab:${leaf}`] = failure()
    expect(summarizeCodexRestartStatus(state).attentionCount).toBe(1)
    expect(summarizeCodexRestartStatus(state).stalePtyIds).toEqual([])
    state.paneAccountRestarts[`tab:${leaf}`] = { ...failure(), phase: 'accepted' }
    expect(summarizeCodexRestartStatus(state).attentionCount).toBe(0)
    state.paneAccountRestarts[`tab:${leaf}`] = failure()
    state.terminalLayoutsByTabId.tab.ptyIdsByLeafId = { [leaf]: 'successor' }
    expect(summarizeCodexRestartStatus(state).attentionCount).toBe(0)
    state.terminalLayoutsByTabId.tab.root = null
    expect(summarizeCodexRestartStatus(state).attentionCount).toBe(0)
  })
  it('counts a pane that is both failed and stale once alongside another stale pane', () => {
    const state = population()
    const otherLeaf = '00000000-0000-4000-8000-000000000002'
    state.tabsByWorktree.wt.push({
      ...state.tabsByWorktree.wt[0],
      id: 'other-tab',
      ptyId: 'other-live'
    })
    state.terminalLayoutsByTabId['other-tab'] = {
      root: { type: 'leaf', leafId: otherLeaf },
      activeLeafId: otherLeaf,
      expandedLeafId: null,
      ptyIdsByLeafId: { [otherLeaf]: 'other-live' }
    }
    state.ptyIdsByTabId['other-tab'] = ['other-live']
    state.codexRestartNoticeByPtyId['other-live'] = awaiting
    state.paneAccountRestarts[`tab:${leaf}`] = failure()
    const result = summarizeCodexRestartStatus(state)
    expect(result.attentionCount).toBe(2)
    expect(result.stalePtyIds).toEqual(['other-live'])
  })
  it('does not count a rootless failure twice when hydration supplies its authoritative leaf', () => {
    const state = population()
    state.paneAccountRestarts['tab:unresolved'] = { ...failure(), leafId: null }
    const result = summarizeCodexRestartStatus(state)
    expect(result.attentionCount).toBe(1)
    expect(result.stalePtyIds).toEqual([])
  })
})
