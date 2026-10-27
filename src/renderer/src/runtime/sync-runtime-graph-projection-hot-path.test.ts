import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../store/types'
import { makeAgentStatusEntry, makeState } from './sync-runtime-graph-test-harness'
import type * as EditorDraftHashModule from './sync-runtime-graph/editor-draft-hash'

// Count characters hashed, not elapsed time: only draft hashing scales per keystroke. Instrument its module without adding shipped counters.
const draftHashCounter = { calls: 0, chars: 0 }
vi.mock('./sync-runtime-graph/editor-draft-hash', async (importOriginal) => {
  const actual = await importOriginal<typeof EditorDraftHashModule>()
  return {
    stableHashString: (value: string): string => {
      draftHashCounter.calls += 1
      draftHashCounter.chars += value.length
      return actual.stableHashString(value)
    }
  }
})

const { stableHashString } = await import('./sync-runtime-graph/editor-draft-hash')
const {
  AGENT_STATUS_SYNC_UPDATED_AT_BUCKET_MS_FOR_TESTS: AGENT_STATUS_SYNC_UPDATED_AT_BUCKET_MS,
  buildRuntimeMobileAgentStatusProjectionForTests,
  resetRuntimeMobileAgentStatusProjectionCacheForTests
} = await import('./sync-runtime-graph/agent-status-projection')
const {
  resetRuntimeMobileSyncProjectionCachesForTests,
  buildRuntimeMobileBrowserProjection,
  buildRuntimeMobileEditorDraftsProjection,
  buildRuntimeMobileOpenFilesProjection
} = await import('./sync-runtime-graph/sync-projections')

type MainAgentStatus = AppState['agentStatusByPaneKey'][string]['mainAgent']
function mainAgentKey(mainAgent: MainAgentStatus) {
  return mainAgent ? [mainAgent.state, mainAgent.outcome ?? null, mainAgent.stateStartedAt] : null
}

function referenceEditorDraftsProjection(editorDrafts: AppState['editorDrafts']): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(editorDrafts).map(([fileId, content]) => [fileId, stableHashString(content)])
    )
  )
}

function referenceOpenFilesProjection(openFiles: AppState['openFiles']): string {
  return JSON.stringify(
    openFiles.map((file) => ({
      id: file.id,
      filePath: file.filePath,
      relativePath: file.relativePath,
      worktreeId: file.worktreeId,
      language: file.language,
      mode: file.mode,
      diffSource: file.diffSource,
      isDirty: file.isDirty,
      mirroredFromRuntimeSession: file.mirroredFromRuntimeSession,
      isUntitled: file.isUntitled,
      deleteUntouchedOnClose: file.deleteUntouchedOnClose,
      markdownPreviewSourceFileId: file.markdownPreviewSourceFileId
    }))
  )
}

function referenceBrowserProjection(state: AppState): string {
  return JSON.stringify({
    workspacesByWorktree: Object.fromEntries(
      Object.entries(state.browserTabsByWorktree ?? {}).map(([worktreeId, workspaces]) => [
        worktreeId,
        workspaces.map((workspace) => ({
          id: workspace.id,
          activePageId: workspace.activePageId,
          title: workspace.title,
          url: workspace.url,
          loading: workspace.loading,
          canGoBack: workspace.canGoBack,
          canGoForward: workspace.canGoForward
        }))
      ])
    ),
    pagesByWorkspace: Object.fromEntries(
      Object.entries(state.browserPagesByWorkspace ?? {}).map(([workspaceId, pages]) => [
        workspaceId,
        pages.map((page) => ({
          id: page.id,
          title: page.title,
          url: page.url,
          loading: page.loading,
          canGoBack: page.canGoBack,
          canGoForward: page.canGoForward
        }))
      ])
    )
  })
}

/** The pre-change agent-status serialization, including its `localeCompare` sort. */
function referenceAgentStatusProjection(map: AppState['agentStatusByPaneKey']): string {
  return JSON.stringify(
    Object.entries(map)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([paneKey, entry]) => ({
        paneKey,
        entryPaneKey: entry.paneKey,
        state: entry.state,
        workingMode: entry.workingMode ?? null,
        prompt: entry.prompt,
        updatedAtBucket: Math.floor(entry.updatedAt / AGENT_STATUS_SYNC_UPDATED_AT_BUCKET_MS),
        stateStartedAt: entry.stateStartedAt,
        turnStartedAt: entry.turnStartedAt ?? null,
        turnEndedAt: entry.turnEndedAt ?? null,
        turnEndDisposition: entry.turnEndDisposition ?? null,
        agentType: entry.agentType ?? null,
        terminalTitle: entry.terminalTitle ?? null,
        stateHistory: entry.stateHistory.map((history) => ({
          state: history.state,
          prompt: history.prompt,
          startedAt: history.startedAt,
          interrupted: history.interrupted ?? null,
          mainAgent: mainAgentKey(history.mainAgent)
        })),
        toolName: entry.toolName ?? null,
        toolInput: entry.toolInput ?? null,
        interactivePrompt: entry.interactivePrompt ?? null,
        lastAssistantMessage: entry.lastAssistantMessage ?? null,
        lastAssistantMessageIsToolOutput: entry.lastAssistantMessageIsToolOutput ?? null,
        interrupted: entry.interrupted ?? null,
        mainAgent: mainAgentKey(entry.mainAgent),
        programStatus: entry.programStatus
          ? [
              entry.programStatus.state,
              entry.programStatus.kind ?? null,
              entry.programStatus.progress ?? null,
              entry.programStatus.message ?? null
            ]
          : null
      }))
  )
}

/** Same entries, code-unit ordered — proves the new sort changes order only, never content. */
function sortedProjectionEntries(projection: string): unknown[] {
  return (JSON.parse(projection) as unknown[]).slice().sort((a, b) => {
    const left = JSON.stringify(a)
    const right = JSON.stringify(b)
    return left < right ? -1 : left > right ? 1 : 0
  })
}

const DRAFT_FILE_COUNT = 5
const DRAFT_CHARS_PER_FILE = 40_000

function makeDrafts(): Record<string, string> {
  const drafts: Record<string, string> = {}
  for (let index = 0; index < DRAFT_FILE_COUNT; index += 1) {
    drafts[`file-${index}`] = 'x'.repeat(DRAFT_CHARS_PER_FILE)
  }
  return drafts
}

function makeOpenFile(index: number, overrides: Record<string, unknown> = {}): never {
  return {
    id: `file-${index}`,
    filePath: `/repo/src/file-${index}.ts`,
    relativePath: `src/file-${index}.ts`,
    worktreeId: 'wt-1',
    language: 'typescript',
    mode: 'edit',
    isDirty: false,
    isUntitled: false,
    ...overrides
  } as never
}

function makeBrowserWorkspace(index: number, overrides: Record<string, unknown> = {}): never {
  return {
    id: `ws-${index}`,
    activePageId: `page-${index}`,
    title: `tab ${index}`,
    url: `https://example.test/${index}`,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    ...overrides
  } as never
}

function makeBrowserPage(index: number, overrides: Record<string, unknown> = {}): never {
  return {
    id: `page-${index}`,
    title: `page ${index}`,
    url: `https://example.test/${index}`,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    ...overrides
  } as never
}

/**
 * Characters handed back by `JSON.stringify`, which is the allocation these projections dominate.
 * Counting bytes rather than calls keeps the comparison fair: the old code made one big call per
 * rebuild, the new code makes one small call per changed entry.
 */
function countSerializedChars(run: () => void): number {
  const original = JSON.stringify
  let chars = 0
  const spy = vi.spyOn(JSON, 'stringify').mockImplementation(((...args: never[]) => {
    const serialized = (original as (...a: never[]) => string)(...args)
    chars += serialized?.length ?? 0
    return serialized
  }) as typeof JSON.stringify)
  try {
    run()
    return chars
  } finally {
    spy.mockRestore()
  }
}

beforeEach(() => {
  draftHashCounter.calls = 0
  draftHashCounter.chars = 0
  resetRuntimeMobileSyncProjectionCachesForTests()
  resetRuntimeMobileAgentStatusProjectionCacheForTests()
})

describe('editor draft projection on the typing path', () => {
  it('hashes only the edited file per keystroke, not every open dirty file', () => {
    const typedCharacters = 100
    const totalDraftChars = DRAFT_FILE_COUNT * DRAFT_CHARS_PER_FILE

    // Baseline: the pre-change uncached projection, driven by the same counter.
    let drafts = makeDrafts()
    referenceEditorDraftsProjection(drafts)
    draftHashCounter.calls = 0
    draftHashCounter.chars = 0
    for (let keystroke = 0; keystroke < typedCharacters; keystroke += 1) {
      drafts = { ...drafts, 'file-0': `${drafts['file-0']}a` }
      referenceEditorDraftsProjection(drafts)
    }
    const before = { calls: draftHashCounter.calls, chars: draftHashCounter.chars }

    resetRuntimeMobileSyncProjectionCachesForTests()
    let memoDrafts = makeDrafts()
    buildRuntimeMobileEditorDraftsProjection(memoDrafts)
    draftHashCounter.calls = 0
    draftHashCounter.chars = 0
    for (let keystroke = 0; keystroke < typedCharacters; keystroke += 1) {
      memoDrafts = { ...memoDrafts, 'file-0': `${memoDrafts['file-0']}a` }
      buildRuntimeMobileEditorDraftsProjection(memoDrafts)
    }
    const after = { calls: draftHashCounter.calls, chars: draftHashCounter.chars }

    // Keystroke k has grown file-0 by k characters, so the exact totals are closed form.
    const growth = (typedCharacters * (typedCharacters + 1)) / 2
    expect(before).toEqual({
      calls: typedCharacters * DRAFT_FILE_COUNT,
      chars: typedCharacters * totalDraftChars + growth
    })
    expect(after).toEqual({
      calls: typedCharacters,
      chars: typedCharacters * DRAFT_CHARS_PER_FILE + growth
    })
    expect(before.chars / after.chars).toBeGreaterThan(DRAFT_FILE_COUNT - 0.1)
  })
})

describe('agent-status projection sort', () => {
  it('constructs no ICU collator, and keeps the same entries as the localeCompare order', () => {
    // Use unordered realistic UUID pane keys at MAX_LIVE_AGENT_STATUSES; sorted tab-N fixtures let TimSort skip the workload.
    let seed = 0x2f6e2b1
    const nextHex = (): string => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed.toString(16).padStart(8, '0')
    }
    const paneKeys = Array.from({ length: 500 }, () => `${nextHex()}-${nextHex()}:${nextHex()}`)
    const map: AppState['agentStatusByPaneKey'] = {}
    for (const [index, paneKey] of paneKeys.entries()) {
      map[paneKey] = makeAgentStatusEntry({ paneKey, prompt: `prompt ${index}` })
    }
    // One ping replaces one entry and re-spreads the map, so the sort runs in full again.
    const pinged = { ...map, [paneKeys[0]]: makeAgentStatusEntry({ paneKey: paneKeys[0] }) }

    const localeCompareSpy = vi.spyOn(String.prototype, 'localeCompare')
    let projection = ''
    let beforeCalls = 0
    let afterCalls = 0
    try {
      referenceAgentStatusProjection(map)
      beforeCalls = localeCompareSpy.mock.calls.length
      localeCompareSpy.mockClear()
      resetRuntimeMobileAgentStatusProjectionCacheForTests()
      projection = buildRuntimeMobileAgentStatusProjectionForTests(map)
      buildRuntimeMobileAgentStatusProjectionForTests(pinged)
      afterCalls = localeCompareSpy.mock.calls.length
    } finally {
      // `mockRestore` clears the recorded calls, so read the counts first.
      localeCompareSpy.mockRestore()
    }
    expect(beforeCalls).toBeGreaterThan(3000)
    expect(afterCalls).toBe(0)

    // The projection is identical up to ordering, and ordering is only ever `===`-compared.
    expect(sortedProjectionEntries(projection)).toEqual(
      sortedProjectionEntries(referenceAgentStatusProjection(map))
    )
  })
})

describe('open-files and browser projections', () => {
  it('re-serializes only the changed entry per store write', () => {
    const files = Array.from({ length: 20 }, (_value, index) => makeOpenFile(index))
    const writes = 50
    const driveWrites = (project: (openFiles: AppState['openFiles']) => string): void => {
      let openFiles = files as unknown as AppState['openFiles']
      project(openFiles)
      for (let write = 0; write < writes; write += 1) {
        const next = [...openFiles]
        next[0] = makeOpenFile(0, { isDirty: write % 2 === 0 })
        openFiles = next as unknown as AppState['openFiles']
        project(openFiles)
      }
    }

    const before = countSerializedChars(() => {
      driveWrites(referenceOpenFilesProjection)
    })
    resetRuntimeMobileSyncProjectionCachesForTests()
    const after = countSerializedChars(() => {
      driveWrites(buildRuntimeMobileOpenFilesProjection)
    })
    // Only the flipped file re-serializes; the other 19 are reused by identity.
    expect(before / after).toBeGreaterThan(14)
  })

  it('re-serializes only the changed browser bucket per store write', () => {
    const workspaces = Array.from({ length: 8 }, (_value, index) => makeBrowserWorkspace(index))
    const pagesByWorkspace: Record<string, never[]> = {}
    for (let index = 0; index < 8; index += 1) {
      pagesByWorkspace[`ws-${index}`] = [makeBrowserPage(index)] as never[]
    }
    const initial = makeState({
      browserTabsByWorktree: { 'wt-1': workspaces, 'wt-2': workspaces } as never,
      browserPagesByWorkspace: pagesByWorkspace as never
    })
    const writes = 50
    const driveWrites = (project: (state: AppState) => string): void => {
      let state = initial
      project(state)
      for (let write = 0; write < writes; write += 1) {
        const nextWorkspaces = [...(state.browserTabsByWorktree['wt-1'] ?? [])]
        nextWorkspaces[0] = makeBrowserWorkspace(0, { title: `tab 0 (${write})` })
        state = makeState({
          ...state,
          browserTabsByWorktree: {
            ...state.browserTabsByWorktree,
            'wt-1': nextWorkspaces
          } as never
        })
        project(state)
      }
    }

    const before = countSerializedChars(() => {
      driveWrites(referenceBrowserProjection)
    })
    resetRuntimeMobileSyncProjectionCachesForTests()
    const after = countSerializedChars(() => {
      driveWrites(buildRuntimeMobileBrowserProjection)
    })
    // Only the 'wt-1' bucket re-serializes; 'wt-2' and every page bucket are reused.
    expect(before / after).toBeGreaterThan(2.5)
  })
})
