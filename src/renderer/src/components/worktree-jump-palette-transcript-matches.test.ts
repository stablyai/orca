import { describe, expect, it } from 'vitest'
import type { AiVaultSearchHit } from '../../../shared/ai-vault-search-types'
import { searchHit } from '../../../shared/ai-vault-search-test-fixture'
import { makePaneKey } from '../../../shared/stable-pane-id'
import type { OriginalPaneState } from './right-sidebar/ai-vault-original-pane'
import { parseAiVaultSnippetMarks } from './right-sidebar/ai-vault-search-snippet-marks'
import { resolvePaletteTranscriptMatches } from './worktree-jump-palette-transcript-matches'
import { LEAF_ID, makeAgentEntry, makeTerminalTab } from './worktree-jump-palette-test-fixtures'

function hit(sessionId: string, snippet: string | null): AiVaultSearchHit {
  return {
    ...searchHit(),
    agent: 'claude',
    sessionId,
    evidence: snippet === null ? null : { role: 'assistant', timestamp: null, snippet }
  }
}

function paneStateFor(panes: { tabId: string; worktreeId: string; sessionId: string }[]) {
  const state: OriginalPaneState = {
    agentStatusByPaneKey: {},
    retainedAgentsByPaneKey: {},
    sleepingAgentSessionsByPaneKey: {},
    tabsByWorktree: {},
    terminalLayoutsByTabId: {}
  }
  for (const { tabId, worktreeId, sessionId } of panes) {
    state.agentStatusByPaneKey[makePaneKey(tabId, LEAF_ID)] = makeAgentEntry(tabId, 'done', 0, {
      agentType: 'claude',
      tabId,
      worktreeId,
      providerSession: { key: 'session_id', id: sessionId }
    })
    state.tabsByWorktree[worktreeId] = [
      ...(state.tabsByWorktree[worktreeId] ?? []),
      makeTerminalTab(tabId, worktreeId, tabId)
    ]
    state.terminalLayoutsByTabId[tabId] = {
      root: { type: 'leaf', leafId: LEAF_ID },
      activeLeafId: LEAF_ID,
      expandedLeafId: null
    }
  }
  return state
}

describe('resolvePaletteTranscriptMatches', () => {
  it('drops a hit with no pane and keeps host order for the rest', () => {
    const state = paneStateFor([
      { tabId: 'term-a', worktreeId: 'wt-a', sessionId: 's-a' },
      { tabId: 'term-b', worktreeId: 'wt-b', sessionId: 's-b' }
    ])
    const matches = resolvePaletteTranscriptMatches(
      [hit('s-b', 'fix the [[flaky]] test'), hit('s-closed', 'x'), hit('s-a', null)],
      state
    )
    expect(matches).toEqual([
      {
        worktreeId: 'wt-b',
        terminalTabId: 'term-b',
        snippet: { text: 'fix the flaky test', ranges: [{ start: 8, end: 13 }] }
      },
      { worktreeId: 'wt-a', terminalTabId: 'term-a', snippet: null }
    ])
  })

  it('keeps one match per tab, the best-ranked hit', () => {
    const state = paneStateFor([{ tabId: 'term-a', worktreeId: 'wt-a', sessionId: 's-a' }])
    const matches = resolvePaletteTranscriptMatches(
      [hit('s-a', '[[first]]'), hit('s-a', '[[second]]')],
      state
    )
    expect(matches.map((match) => match.snippet?.text)).toEqual(['first'])
  })

  it('returns nothing when there are no hits', () => {
    expect(resolvePaletteTranscriptMatches([], paneStateFor([]))).toEqual([])
  })
})

describe('parseAiVaultSnippetMarks', () => {
  it('strips the host marks and reports their ranges in the plain text', () => {
    expect(parseAiVaultSnippetMarks('[[a]] b [[cd]]')).toEqual({
      text: 'a b cd',
      ranges: [
        { start: 0, end: 1 },
        { start: 4, end: 6 }
      ]
    })
    expect(parseAiVaultSnippetMarks('plain')).toEqual({ text: 'plain', ranges: [] })
  })
})
