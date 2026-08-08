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
    source: 'workspace',
    id: `open-tab:workspace:tab-${relativePath ?? 'none'}`,
    title: 'zebra.ts',
    matchedText: null,
    worktreeId: 'wt-1',
    contentType: 'editor',
    tabId: 'tab-1',
    entityId: 'file-1',
    groupId: 'group-1',
    relativePath
  }
}

describe('dropFileEntriesCoveredByTabResults', () => {
  it('drops the file row that duplicates an open editor tab', () => {
    const options = [existingFile('src/zebra.ts'), existingFile('src/other.ts')]

    expect(
      dropFileEntriesCoveredByTabResults(options, [editorTab('src/zebra.ts')]).map(
        (option) => option.id
      )
    ).toEqual(['existing-file:src/other.ts'])
  })

  it('matches paths that differ only in separator style', () => {
    expect(
      dropFileEntriesCoveredByTabResults(
        [existingFile('src/zebra.ts')],
        [editorTab('src\\zebra.ts')]
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

    expect(dropFileEntriesCoveredByTabResults(options, [editorTab('src/zebra.ts')])).toHaveLength(3)
  })

  it('never lets a terminal, browser or simulator result suppress a file entry', () => {
    const results: OpenTabSearchResult[] = [
      { ...editorTab(null), contentType: 'terminal' },
      {
        source: 'browser',
        id: 'open-tab:browser:page-1',
        title: 'zebra',
        matchedText: null,
        worktreeId: 'wt-1',
        contentType: 'browser',
        pageId: 'page-1',
        workspaceId: 'ws-1'
      },
      {
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
      dropFileEntriesCoveredByTabResults([existingFile('src/zebra.ts')], results)
    ).toHaveLength(1)
  })

  it('returns the same array when no tab result carries a path', () => {
    const options = [existingFile('src/zebra.ts')]

    expect(dropFileEntriesCoveredByTabResults(options, [])).toBe(options)
  })
})
