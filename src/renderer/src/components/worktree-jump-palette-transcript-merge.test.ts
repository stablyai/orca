import { expect, it } from 'vitest'
import { searchWorkspaceTabs } from '@/lib/workspace-tab-palette-search'
import { createPaletteSearchContext } from '@/lib/palette-match/palette-ranking'
import { transcriptTab } from './cmd-j/palette-transcript-test-fixture'
import {
  buildOpenTabPaletteItems,
  buildWorkspaceTabPaletteItems
} from './worktree-jump-palette-open-tab-items'
import {
  mergeWorkspaceTabTranscriptMatches,
  paletteTranscriptTabKey,
  type PaletteTranscriptMatch
} from './worktree-jump-palette-transcript-matches'

const context = createPaletteSearchContext(10000)
const snippet = { text: 'a refresh race here', ranges: [{ start: 2, end: 14 }] }
const transcript = (id: string, ordinal: number, complete = true): PaletteTranscriptMatch => ({
  worktreeId: 'workspace',
  tabId: id,
  ordinal,
  complete,
  snippet,
  windows: []
})

it('merges name highlights and independent transcript strength onto one host-aware destination', () => {
  const entries = [
    transcriptTab('exact', 'refresh'),
    transcriptTab('weak', 'prerefreshpost'),
    transcriptTab('indexed', 'Conversation')
  ]
  const titles = buildWorkspaceTabPaletteItems(searchWorkspaceTabs(entries, 'refresh', { context }))
  const originalHighlights = titles.find((item) => item.result.tabId === 'weak')?.result.titleRanges
  const merged = mergeWorkspaceTabTranscriptMatches({
    titleItems: titles,
    entries,
    matches: [transcript('weak', 9), transcript('indexed', 2)],
    context,
    isTranscriptWorktree: () => true,
    eligibleTabs: new Set(
      entries.map((entry) => paletteTranscriptTabKey(entry.worktree.id, entry.tab.entityId))
    )
  })
  const rows = buildOpenTabPaletteItems({
    browserItems: [],
    simulatorItems: [],
    workspaceTabItems: merged.titleItems,
    transcriptOnlyItems: merged.transcriptOnlyItems
  })
  expect(rows.map((item) => (item.type === 'workspace-tab' ? item.result.tabId : item.id))).toEqual(
    ['exact', 'indexed', 'weak']
  )
  const weak = merged.titleItems.find((item) => item.result.tabId === 'weak')
  expect(weak?.result.titleRanges).toEqual(originalHighlights)
  expect(weak?.result.qualityClass).toBe('partial-evidence')
  expect(weak?.transcriptSnippet).toBe(snippet)
  expect(weak?.transcript).toEqual({ complete: true, ordinal: 9 })
})

it('reserves eligible local geometry even with empty responses, and never adds local evidence to a remote owner', () => {
  const local = transcriptTab('local', 'refresh')
  const remote: ReturnType<typeof transcriptTab> = {
    ...transcriptTab('remote', 'refresh'),
    worktree: { ...local.worktree, hostId: 'runtime:paired' }
  }
  const titles = buildWorkspaceTabPaletteItems(
    searchWorkspaceTabs([local, remote], 'refresh', { context })
  )
  const merge = (matches: readonly PaletteTranscriptMatch[]) =>
    mergeWorkspaceTabTranscriptMatches({
      titleItems: titles,
      entries: [local, remote],
      matches,
      context,
      isTranscriptWorktree: (worktree) => worktree.hostId !== 'runtime:paired',
      eligibleTabs: new Set([
        paletteTranscriptTabKey('workspace', 'local'),
        paletteTranscriptTabKey('workspace', 'remote')
      ])
    })
  const empty = merge([])
  expect(empty.titleItems.find((item) => item.result.tabId === 'local')?.transcriptReserved).toBe(
    true
  )
  expect(empty.titleItems.find((item) => item.result.tabId === 'remote')?.transcriptReserved).toBe(
    false
  )
  const evidence = merge([transcript('remote', 0)])
  expect(evidence.titleItems.every((item) => !item.transcriptSnippet)).toBe(true)
  expect(evidence.transcriptOnlyItems).toEqual([])
})

it('rejects an explicitly remote tab even when its workspace uses a local legacy identity', () => {
  const local = transcriptTab('collision', 'refresh')
  const remote: ReturnType<typeof transcriptTab> = {
    ...local,
    tab: { ...local.tab, executionHostId: 'runtime:paired' }
  }
  const titles = buildWorkspaceTabPaletteItems(searchWorkspaceTabs([local], 'refresh', { context }))
  const merged = mergeWorkspaceTabTranscriptMatches({
    titleItems: titles,
    entries: [local, remote],
    matches: [transcript('collision', 0)],
    eligibleTabs: new Set([paletteTranscriptTabKey('workspace', 'collision')]),
    context,
    isTranscriptWorktree: () => true
  })
  expect(
    merged.titleItems
      .filter((item) => item.transcriptSnippet)
      .map((item) => item.result.executionHostId)
  ).toEqual([undefined])
})

it('merges evidence and reservations only onto the matching host for colliding workspace and tab ids', () => {
  const local = transcriptTab('collision', 'refresh')
  const remote: ReturnType<typeof transcriptTab> = {
    ...local,
    tab: { ...local.tab, executionHostId: 'runtime:remote' },
    worktree: { ...local.worktree, hostId: 'runtime:remote' }
  }
  const entries = [local, remote]
  const titles = buildWorkspaceTabPaletteItems(searchWorkspaceTabs(entries, 'refresh', { context }))
  const remoteMatch = { ...transcript('collision', 1), executionHostId: 'runtime:remote' as const }
  const merged = mergeWorkspaceTabTranscriptMatches({
    titleItems: titles,
    entries,
    matches: [remoteMatch],
    eligibleTabs: new Set([paletteTranscriptTabKey('workspace', 'collision', 'runtime:remote')]),
    context,
    isTranscriptWorktree: () => true
  })
  expect(
    merged.titleItems.map((item) => [
      item.result.executionHostId,
      Boolean(item.transcriptSnippet),
      item.transcriptReserved
    ])
  ).toEqual([
    [undefined, false, false],
    ['runtime:remote', true, true]
  ])
})

it('uses the workspace host resolver when a native tab has no explicit host', () => {
  const entry: ReturnType<typeof transcriptTab> = {
    ...transcriptTab('native', 'Conversation'),
    tab: { ...transcriptTab('native').tab, contentType: 'agent-session' },
    worktree: {
      ...transcriptTab('native').worktree,
      hostId: 'local',
      runtimeOwnerEnvironmentId: 'remote'
    }
  }
  const merged = mergeWorkspaceTabTranscriptMatches({
    titleItems: [],
    entries: [entry],
    matches: [{ ...transcript('native', 0), executionHostId: 'runtime:remote' }],
    eligibleTabs: new Set([paletteTranscriptTabKey('workspace', 'native', 'runtime:remote')]),
    context,
    isTranscriptWorktree: () => true,
    executionHostIdForWorktree: () => 'runtime:remote'
  })
  expect(merged.transcriptOnlyItems).toMatchObject([
    {
      result: { tabId: 'native', executionHostId: 'runtime:remote' },
      transcriptSnippet: snippet,
      transcriptReserved: true
    }
  ])
})
