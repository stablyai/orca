import { describe, expect, it } from 'vitest'
import type { OpenTabSearchResult } from './open-tab-search'
import type { TabEntryOption } from './tab-create-entry-action'
import { dropFileEntriesCoveredByTabResults } from './open-tab-entry-dedupe'

function existingFile(relativePath: string): TabEntryOption {
  return {
    id: `existing-file:${relativePath}`,
    classification: { kind: 'existing-file', matchKind: 'fuzzy', relativePath }
  }
}

function editorTab(
  relativePath: string | null
): Extract<OpenTabSearchResult, { source: 'workspace' }> {
  return {
    executionHostId: 'local',
    source: 'workspace',
    id: `open-tab:workspace:tab-${relativePath ?? 'none'}`,
    title: 'zebra.ts',
    matchedText: null,
    worktreeId: 'wt-1',
    contentType: 'editor',
    tabId: 'tab-1',
    entityId: 'file-1',
    groupId: 'group-1',
    relativePath,
    occupantAgent: null
  }
}

const POSIX_ROOT = '/tmp/wt-1'
const WINDOWS_ROOT = 'C:\\repos\\wt-1'
const WSL_ROOT = '\\\\wsl.localhost\\Ubuntu\\home\\ada\\wt-1'

describe('dropFileEntriesCoveredByTabResults', () => {
  it('drops the file row that duplicates an open editor tab', () => {
    const options = [existingFile('src/zebra.ts'), existingFile('src/other.ts')]

    expect(
      dropFileEntriesCoveredByTabResults(options, [editorTab('src/zebra.ts')], POSIX_ROOT).map(
        (option) => option.id
      )
    ).toEqual(['existing-file:src/other.ts'])
  })

  it('matches paths that differ only in separator style', () => {
    expect(
      dropFileEntriesCoveredByTabResults(
        [existingFile('src/zebra.ts')],
        [editorTab('src\\zebra.ts')],
        POSIX_ROOT
      )
    ).toEqual([])
  })

  it('keeps new-file, URL and absolute-path rows even when the path matches', () => {
    const options: TabEntryOption[] = [
      {
        id: 'new-file:src/zebra.ts',
        classification: { kind: 'new-file', relativePath: 'src/zebra.ts' }
      },
      {
        id: 'absolute-file:/tmp/wt-1/src/zebra.ts',
        classification: { kind: 'absolute-file', filePath: '/tmp/wt-1/src/zebra.ts' }
      },
      {
        id: 'host-url:https://zebra.dev',
        classification: { kind: 'host-url', url: 'https://zebra.dev' }
      }
    ]

    expect(
      dropFileEntriesCoveredByTabResults(options, [editorTab('src/zebra.ts')], POSIX_ROOT)
    ).toHaveLength(3)
  })

  it('never lets a terminal, browser or simulator result suppress a file entry', () => {
    const results: OpenTabSearchResult[] = [
      // Non-null path on purpose: the fold must turn on contentType, not on a
      // path the engine happens to leave empty for non-editor tabs.
      { ...editorTab('src/zebra.ts'), contentType: 'terminal' },
      {
        executionHostId: 'local',
        source: 'browser',
        id: 'open-tab:browser:page-1',
        title: 'zebra',
        matchedText: null,
        worktreeId: 'wt-1',
        contentType: 'browser',
        pageId: 'page-1',
        url: 'https://example.com/zebra',
        workspaceId: 'ws-1',
        faviconUrl: null
      },
      {
        executionHostId: 'local',
        source: 'simulator',
        id: 'open-tab:simulator:tab-2',
        title: 'zebra',
        matchedText: null,
        worktreeId: 'wt-1',
        contentType: 'simulator',
        tabId: 'tab-2',
        groupId: 'group-1'
      }
    ]

    expect(
      dropFileEntriesCoveredByTabResults([existingFile('src/zebra.ts')], results, POSIX_ROOT)
    ).toHaveLength(1)
  })

  it('dedupes case-only differences on a Windows worktree', () => {
    expect(
      dropFileEntriesCoveredByTabResults(
        [existingFile('src/Zebra.ts')],
        [editorTab('SRC/zebra.ts')],
        WINDOWS_ROOT
      )
    ).toEqual([])
  })

  it('keeps case-only differences on case-sensitive worktrees', () => {
    for (const root of [POSIX_ROOT, WSL_ROOT]) {
      expect(
        dropFileEntriesCoveredByTabResults(
          [existingFile('src/Zebra.ts')],
          [editorTab('src/zebra.ts')],
          root
        )
      ).toHaveLength(1)
    }
  })

  // A Windows client can drive a case-sensitive SSH worktree, so the client
  // platform must never decide the fold.
  it('keeps case-only differences when the worktree path is unknown', () => {
    expect(
      dropFileEntriesCoveredByTabResults(
        [existingFile('src/Zebra.ts')],
        [editorTab('src/zebra.ts')],
        null
      )
    ).toHaveLength(1)
  })

  it('matches a decomposed listing against a composed editor path', () => {
    expect(
      dropFileEntriesCoveredByTabResults(
        [existingFile('src/café.ts'.normalize('NFD'))],
        [editorTab('src/café.ts'.normalize('NFC'))],
        POSIX_ROOT
      )
    ).toEqual([])
  })

  it('returns the same array when no tab result carries a path', () => {
    const options = [existingFile('src/zebra.ts')]

    expect(dropFileEntriesCoveredByTabResults(options, [], POSIX_ROOT)).toBe(options)
  })
})
