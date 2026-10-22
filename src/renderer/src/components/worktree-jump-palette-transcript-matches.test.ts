import { describe, expect, it } from 'vitest'
import type { AiVaultSearchHit } from '../../../shared/ai-vault-search-types'
import { searchHit } from '../../../shared/ai-vault-search-test-fixture'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { buildPaletteTranscriptIndex } from './cmd-j/palette-transcript-structured-tabs'
import type { OriginalPaneState } from './right-sidebar/ai-vault-original-pane'
import {
  buildAiVaultOriginalPaneIndex,
  findOriginalAiVaultSessionPaneInIndex
} from './right-sidebar/ai-vault-original-pane-index'
import { aiVaultSearchHitToSession } from './right-sidebar/ai-vault-search-session'
import { parseAiVaultSnippetMarks } from './right-sidebar/ai-vault-search-snippet-marks'
import {
  fitPaletteTranscriptMatches,
  resolvePaletteTranscriptMatches
} from './worktree-jump-palette-transcript-matches'
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
        ordinal: 0,
        complete: false,
        windows: [],
        tabId: 'term-b',
        snippet: { text: 'fix the flaky test', ranges: [{ start: 8, end: 13 }] }
      },
      {
        worktreeId: 'wt-a',
        tabId: 'term-a',
        snippet: null,
        ordinal: 2,
        complete: false,
        windows: []
      }
    ])
  })

  it('folds sessions only after display fit, preferring proof and then the original ordinal', () => {
    const state = paneStateFor([{ tabId: 'term-a', worktreeId: 'wt-a', sessionId: 's-a' }])
    const matches = resolvePaletteTranscriptMatches(
      [hit('s-a', '[[first]]'), hit('s-a', '[[second]]')],
      state
    )
    expect(matches.map((match) => match.snippet?.text)).toEqual(['first', 'second'])
    expect(
      fitPaletteTranscriptMatches(matches, new Map()).map((match) => match.snippet?.text)
    ).toEqual(['first'])
    const proof = { text: 'verified', ranges: [{ start: 0, end: 8 }] }
    expect(fitPaletteTranscriptMatches(matches, new Map([[1, proof]]))).toMatchObject([
      { ordinal: 1, complete: true, snippet: proof }
    ])
  })

  it('emits each valid tab for a resumed provider session, folding split panes and preserving sidebar choice', () => {
    const state = paneStateFor([
      { tabId: 'term-a', worktreeId: 'wt-a', sessionId: 'same-session' },
      { tabId: 'term-b', worktreeId: 'wt-b', sessionId: 'same-session' },
      { tabId: 'closed', worktreeId: 'wt-a', sessionId: 'same-session' }
    ])
    state.tabsByWorktree['wt-a'] = state.tabsByWorktree['wt-a']?.filter(
      (tab) => tab.id !== 'closed'
    )
    const splitLeaf = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    state.terminalLayoutsByTabId['term-a'] = {
      root: {
        type: 'split',
        direction: 'horizontal',
        first: { type: 'leaf', leafId: LEAF_ID },
        second: { type: 'leaf', leafId: splitLeaf }
      },
      activeLeafId: LEAF_ID,
      expandedLeafId: null
    }
    const splitKey = makePaneKey('term-a', splitLeaf)
    state.agentStatusByPaneKey[splitKey] = makeAgentEntry('term-a', 'done', 0, {
      paneKey: splitKey,
      agentType: 'claude',
      tabId: 'term-a',
      worktreeId: 'wt-a',
      providerSession: { key: 'session_id', id: 'same-session' }
    })
    const evidence = hit('same-session', 'a [[refresh]] here')
    expect(
      resolvePaletteTranscriptMatches([evidence], state).map((match) => [
        match.worktreeId,
        match.tabId
      ])
    ).toEqual([
      ['wt-a', 'term-a'],
      ['wt-b', 'term-b']
    ])
    expect(
      findOriginalAiVaultSessionPaneInIndex(
        buildAiVaultOriginalPaneIndex(state),
        aiVaultSearchHitToSession(evidence, 'local')
      )?.tabId
    ).toBe('term-a')
  })

  it('returns nothing when there are no hits', () => {
    expect(resolvePaletteTranscriptMatches([], paneStateFor([]))).toEqual([])
  })

  it('preserves unique legacy prompt fallback and exact provider precedence with a prepared index', () => {
    const state = paneStateFor([
      { tabId: 'legacy', worktreeId: 'workspace', sessionId: 'old' },
      { tabId: 'exact', worktreeId: 'workspace', sessionId: 'current' }
    ])
    const legacy = state.agentStatusByPaneKey[makePaneKey('legacy', LEAF_ID)]
    legacy.providerSession = undefined
    legacy.prompt = 'Investigate the refresh race in the workspace'
    const evidence = { ...hit('unknown', null), title: legacy.prompt }
    expect(
      resolvePaletteTranscriptMatches(
        [evidence, { ...evidence, sessionId: 'current' }],
        state,
        '',
        undefined,
        buildPaletteTranscriptIndex(state)
      ).map((match) => [match.tabId, match.ordinal])
    ).toEqual([
      ['legacy', 0],
      ['exact', 1]
    ])
    const exact = state.agentStatusByPaneKey[makePaneKey('exact', LEAF_ID)]
    exact.providerSession = undefined
    exact.prompt = legacy.prompt
    expect(
      resolvePaletteTranscriptMatches(
        [evidence],
        state,
        '',
        undefined,
        buildPaletteTranscriptIndex(state)
      )
    ).toEqual([])
    legacy.providerSession = { key: 'session_id', id: 'different-session' }
    expect(
      resolvePaletteTranscriptMatches(
        [evidence],
        state,
        '',
        undefined,
        buildPaletteTranscriptIndex(state)
      ).map((match) => match.tabId)
    ).toEqual(['exact'])
  })

  it('folds only within a host when identical workspace and tab ids appear on several hosts', () => {
    const local = resolvePaletteTranscriptMatches(
      [hit('session', null)],
      paneStateFor([{ tabId: 'terminal', worktreeId: 'workspace', sessionId: 'session' }])
    )[0]
    const remote = { ...local, executionHostId: 'runtime:remote' as const, ordinal: 1 }
    const proof = { text: 'verified', ranges: [{ start: 0, end: 8 }] }
    expect(fitPaletteTranscriptMatches([local, remote], new Map([[1, proof]]))).toEqual([
      local,
      { ...remote, snippet: proof, complete: true }
    ])
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
