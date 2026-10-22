// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { searchHit, searchResults } from '../../../shared/ai-vault-search-test-fixture'
import type { AiVaultSearchRequest } from '../../../shared/ai-vault-search-types'
import { getDefaultSettings } from '../../../shared/constants'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { useWorktreeJumpPaletteTranscriptMatches } from './use-worktree-jump-palette-transcript-matches'
import { EMPTY_PALETTE_FILTER } from './cmd-j/palette-filter'
import { buildPaletteFilterModel } from './cmd-j/palette-filter-options'
import {
  LEAF_ID,
  makeAgentEntry,
  makeTerminalTab,
  makeWorktree
} from './worktree-jump-palette-test-fixtures'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it.each([0, 100])(
  'loads pages by fitted complete-destination demand with %i initial incomplete hits',
  async (incomplete) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const workspace = makeWorktree('workspace', 'Workspace')
    const hits = Array.from({ length: 225 }, (_, index) => ({
      ...searchHit(),
      sessionId: String(index),
      evidence: {
        role: 'assistant' as const,
        timestamp: null,
        snippet: 'a [[refresh]] here',
        originalExcerpt: { text: index < incomplete ? 'a réfresh here' : 'a refresh here' }
      }
    }))
    const searchSessions = vi.fn(async (request: AiVaultSearchRequest) => {
      const start = Number(request.cursor ?? 0)
      const end = start + (request.limit ?? 100)
      return {
        ...searchResults(),
        eligibleSessionsApplied: true as const,
        forksPreserved: true as const,
        hits: hits.slice(start, end),
        page: { hasMore: end < hits.length, cursor: end < hits.length ? String(end) : null }
      }
    })
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { ...window.api, aiVault: { searchSessions } }
    })
    const initialProps: Parameters<typeof useWorktreeJumpPaletteTranscriptMatches>[0] = {
      settings: {
        ...getDefaultSettings('/home/test'),
        aiVaultSearch: { enabled: true, historyDays: null }
      },
      visible: true,
      query: 'refresh',
      deferredQuery: 'refresh',
      filter: EMPTY_PALETTE_FILTER,
      expandedSectionCaps: {},
      filterPredicate: null,
      filterModel: buildPaletteFilterModel({
        repos: [],
        worktrees: [workspace],
        hostOptions: [],
        projects: [],
        projectHostSetups: []
      }),
      workspaces: [workspace],
      unifiedTabsByWorktree: {},
      retainedAgentsByPaneKey: {},
      sleepingAgentSessionsByPaneKey: {},
      tabsByWorktree: {
        workspace: hits.map((hit) =>
          makeTerminalTab(`tab-${hit.sessionId}`, 'workspace', 'Conversation')
        )
      },
      terminalLayoutsByTabId: Object.fromEntries(
        hits.map((hit) => [
          `tab-${hit.sessionId}`,
          { root: { type: 'leaf', leafId: LEAF_ID }, activeLeafId: LEAF_ID, expandedLeafId: null }
        ])
      ),
      agentStatusByPaneKey: Object.fromEntries(
        hits.map((hit) => {
          const tabId = `tab-${hit.sessionId}`
          return [
            makePaneKey(tabId, LEAF_ID),
            makeAgentEntry(tabId, 'done', 0, {
              agentType: hit.agent,
              tabId,
              worktreeId: 'workspace',
              providerSession: { key: 'session_id', id: hit.sessionId }
            })
          ]
        })
      )
    }
    const { result, rerender } = renderHook(useWorktreeJumpPaletteTranscriptMatches, {
      initialProps
    })
    await act(async () => vi.advanceTimersByTimeAsync(120))
    expect(searchSessions).toHaveBeenCalledTimes(1)
    expect(result.current.transcriptMeasurement.candidates).toHaveLength(100)
    const fitCurrentPage = () =>
      act(() =>
        result.current.transcriptMeasurement.onFits(
          new Map(
            result.current.transcriptMeasurement.candidates.flatMap((candidate) =>
              candidate.windows[0] ? [[candidate.ordinal, candidate.windows[0]] as const] : []
            )
          ),
          'display'
        )
      )
    fitCurrentPage()
    await act(async () => {})
    if (incomplete) {
      expect(searchSessions).toHaveBeenCalledTimes(2)
      fitCurrentPage()
      expect(result.current.transcriptMatches.find((match) => match.complete)?.ordinal).toBe(100)
    }
    rerender({ ...initialProps, expandedSectionCaps: { 'open-tabs': 60 } })
    fitCurrentPage()
    await act(async () => {})
    expect(searchSessions).toHaveBeenCalledTimes(incomplete ? 3 : 2)
    expect(result.current.transcriptMeasurement.candidates).toHaveLength(incomplete ? 225 : 200)
    fitCurrentPage()
    rerender({ ...initialProps, expandedSectionCaps: { 'open-tabs': 200 } })
    fitCurrentPage()
    await act(async () => {})
    expect(searchSessions).toHaveBeenCalledTimes(3)
    expect(result.current.transcriptMeasurement.candidates).toHaveLength(225)
    const last = result.current.transcriptMeasurement.candidates[224]
    expect(last.ordinal).toBe(224)
    expect(last.windows.length).toBeGreaterThan(0)
    act(() =>
      result.current.transcriptMeasurement.onFits(
        new Map([[last.ordinal, last.windows[0]]]),
        'display'
      )
    )
    expect(result.current.transcriptMatches[224]).toMatchObject({
      ordinal: 224,
      tabId: 'tab-224',
      complete: true
    })
    await act(async () => vi.advanceTimersByTimeAsync(1000))
    expect(searchSessions).toHaveBeenCalledTimes(3)
    rerender({ ...initialProps, query: 'changed' })
    expect(result.current.transcriptMeasurement.candidates).toEqual([])
    expect(result.current.transcriptMatches).toEqual([])
  }
)
