import { afterEach, describe, expect, it } from 'vitest'
import { collectRendererMemoryProfileCounts } from '../../lib/renderer-memory-profile'
import {
  measureEditorDiffContents,
  measureEditorFileContents,
  registerEditorContentCensusReader,
  resetEditorContentCensusForTesting
} from './editor-content-memory-census'
import type { DiffContent } from './editor-panel-content-types'

describe('measureEditorFileContents', () => {
  it('counts entries and total characters of the loaded file bodies', () => {
    expect(
      measureEditorFileContents({
        a: { content: 'abc', isBinary: false },
        b: { content: 'de', isBinary: false }
      })
    ).toEqual({ files: 2, chars: 5 })
  })

  it('tolerates an entry with no content string', () => {
    expect(
      measureEditorFileContents({
        a: { content: undefined as unknown as string, isBinary: true }
      })
    ).toEqual({ files: 1, chars: 0 })
  })
})

describe('measureEditorDiffContents', () => {
  // Why both sides: a diff tab retains the original and the modified body, so
  // counting one of them halves the number in the report meant to settle where
  // the heap went.
  it('counts both sides of every open diff', () => {
    expect(
      measureEditorDiffContents({
        a: {
          kind: 'text',
          originalContent: 'abcd',
          modifiedContent: 'ef',
          originalIsBinary: false,
          modifiedIsBinary: false
        },
        b: {
          kind: 'text',
          originalContent: '',
          modifiedContent: 'ghi',
          originalIsBinary: false,
          modifiedIsBinary: false
        }
      })
    ).toEqual({ diffTabs: 2, diffChars: 9 })
  })

  it('counts a binary diff, whose base64 bodies are the largest of all', () => {
    expect(
      measureEditorDiffContents({
        a: {
          kind: 'binary',
          originalContent: 'x'.repeat(1_000),
          modifiedContent: 'y'.repeat(2_000),
          originalIsBinary: true,
          modifiedIsBinary: true
        }
      })
    ).toEqual({ diffTabs: 1, diffChars: 3_000 })
  })

  it('tolerates an entry with no content strings', () => {
    expect(
      measureEditorDiffContents({
        a: { kind: 'text' } as unknown as DiffContent
      })
    ).toEqual({ diffTabs: 1, diffChars: 0 })
  })
})

describe('editor content memory profile contributor', () => {
  it('reports React-held file bodies, which the store-only profile cannot see', () => {
    // Why: crash bundles show gigabytes retained with every store collection
    // count unchanged. File contents live in useState, outside that profile.
    const release = registerEditorContentCensusReader(() => ({
      files: 3,
      chars: 4_000_000,
      diffTabs: 0,
      diffChars: 0
    }))

    expect(collectRendererMemoryProfileCounts()).toMatchObject({
      'editorContent.panels': 1,
      'editorContent.files': 3,
      'editorContent.chars': 4_000_000
    })

    release()
    expect(collectRendererMemoryProfileCounts()).toMatchObject({
      'editorContent.panels': 0,
      'editorContent.files': 0,
      'editorContent.chars': 0
    })
  })

  it('sums every mounted panel so a split editor is not undercounted', () => {
    const releaseA = registerEditorContentCensusReader(() => ({
      files: 2,
      chars: 100,
      diffTabs: 1,
      diffChars: 40
    }))
    const releaseB = registerEditorContentCensusReader(() => ({
      files: 5,
      chars: 900,
      diffTabs: 2,
      diffChars: 60
    }))

    expect(collectRendererMemoryProfileCounts()).toMatchObject({
      'editorContent.panels': 2,
      'editorContent.files': 7,
      'editorContent.chars': 1000,
      'editorContent.diffTabs': 3,
      'editorContent.diffChars': 100
    })

    releaseA()
    releaseB()
  })

  it('reports how many panels the reader cap dropped instead of undercounting silently', () => {
    // Why: past the cap the census stops seeing new panels. A stuck `panels: 64`
    // is indistinguishable from "exactly 64 panels" unless the drops are named.
    for (let i = 0; i < 66; i += 1) {
      registerEditorContentCensusReader(() => ({ files: 1, chars: 10, diffTabs: 0, diffChars: 0 }))
    }

    expect(collectRendererMemoryProfileCounts()).toMatchObject({
      'editorContent.panels': 64,
      'editorContent.droppedPanels': 2
    })
  })

  it('counts a panel that mounted past the cap once a sibling frees its slot', () => {
    // Why: panels register once in a mount effect, so a panel dropped at the cap would
    // stay invisible for its whole life — a permanent undercount of the live heap.
    const releases = Array.from({ length: 64 }, () =>
      registerEditorContentCensusReader(() => ({ files: 1, chars: 10, diffTabs: 0, diffChars: 0 }))
    )
    const lateRelease = registerEditorContentCensusReader(() => ({
      files: 1,
      chars: 5_000,
      diffTabs: 0,
      diffChars: 0
    }))

    expect(collectRendererMemoryProfileCounts()).toMatchObject({
      'editorContent.chars': 640,
      'editorContent.droppedPanels': 1
    })

    releases[0]()
    expect(collectRendererMemoryProfileCounts()).toMatchObject({
      'editorContent.panels': 64,
      'editorContent.chars': 5_630,
      'editorContent.droppedPanels': 0
    })

    lateRelease()
    for (const release of releases.slice(1)) {
      release()
    }
  })

  it('forgets a waiting panel that unmounts before a slot frees', () => {
    const releases = Array.from({ length: 64 }, () =>
      registerEditorContentCensusReader(() => ({ files: 1, chars: 10, diffTabs: 0, diffChars: 0 }))
    )
    const waitingRelease = registerEditorContentCensusReader(() => ({
      files: 1,
      chars: 5_000,
      diffTabs: 0,
      diffChars: 0
    }))

    waitingRelease()
    releases[0]()

    expect(collectRendererMemoryProfileCounts()).toMatchObject({
      'editorContent.panels': 63,
      'editorContent.chars': 630,
      'editorContent.droppedPanels': 0
    })

    for (const release of releases.slice(1)) {
      release()
    }
  })

  it('stops reporting a panel dropped past both caps once it unmounts', () => {
    // Why: `droppedPanels` names what this collect could not see, so a cumulative count
    // would keep claiming omissions after every mounted panel is back under the cap.
    const releases = Array.from({ length: 128 }, () =>
      registerEditorContentCensusReader(() => ({ files: 1, chars: 10, diffTabs: 0, diffChars: 0 }))
    )
    const droppedRelease = registerEditorContentCensusReader(() => ({
      files: 1,
      chars: 5_000,
      diffTabs: 0,
      diffChars: 0
    }))

    expect(collectRendererMemoryProfileCounts()).toMatchObject({
      'editorContent.panels': 64,
      'editorContent.droppedPanels': 65
    })

    droppedRelease()
    expect(collectRendererMemoryProfileCounts()).toMatchObject({
      'editorContent.droppedPanels': 64
    })

    droppedRelease()
    expect(collectRendererMemoryProfileCounts()).toMatchObject({
      'editorContent.droppedPanels': 64
    })

    for (const release of releases) {
      release()
    }
  })

  it('keeps summing panels when one reader throws, instead of zeroing the subsystem', () => {
    // Why: a panel tearing down mid-collect used to fail the whole contributor, which
    // reports only `editorContent.error` — erasing every other panel's file bodies.
    const releaseThrowing = registerEditorContentCensusReader(() => {
      throw new Error('panel torn down')
    })
    const releaseHealthy = registerEditorContentCensusReader(() => ({
      files: 2,
      chars: 900,
      diffTabs: 1,
      diffChars: 100
    }))

    expect(collectRendererMemoryProfileCounts()).toMatchObject({
      'editorContent.panels': 1,
      'editorContent.files': 2,
      'editorContent.chars': 900,
      'editorContent.diffChars': 100,
      'editorContent.readErrors': 1
    })
    expect(collectRendererMemoryProfileCounts()).not.toHaveProperty('editorContent.error')

    releaseThrowing()
    releaseHealthy()
  })

  afterEach(() => {
    resetEditorContentCensusForTesting()
  })
})
