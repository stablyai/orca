import { afterEach, expect, it } from 'vitest'
import type { DiffSection } from '../../diff-section-types'
import {
  claimCombinedDiffView,
  clearCombinedDiffViewMemory,
  readCombinedDiffViewMemory,
  releaseCombinedDiffView,
  rememberCombinedDiffView
} from './combined-diff-view-cache'

function rememberView(index: number, section: Partial<DiffSection> = {}) {
  const lease = claimCombinedDiffView(`view-${index}`, 'workspace')
  const sections: DiffSection[] = [
    {
      key: 'unstaged:file.ts',
      path: 'file.ts',
      status: 'modified',
      area: 'unstaged',
      originalContent: 'base',
      modifiedContent: `draft-${index}`,
      collapsed: false,
      loading: false,
      dirty: false,
      diffResult: null,
      largeDiffRenderLimit: null,
      ...section
    }
  ]
  rememberCombinedDiffView(lease, {
    view: {
      entrySignature: 'one',
      gitStatusSignature: '',
      sections,
      sectionHeights: {},
      loadedIndices: [0],
      sideBySide: false
    }
  })
  return lease
}

afterEach(clearCombinedDiffViewMemory)

it.each([{ dirty: true }, { saveConflict: true as const }])(
  'keeps unmounted drafts past the view history limit: %j',
  (state) => {
    releaseCombinedDiffView(rememberView(0, state))
    for (let index = 1; index <= 21; index++) {
      releaseCombinedDiffView(rememberView(index))
    }
    expect(readCombinedDiffViewMemory('view-0')?.view?.sections[0]?.modifiedContent).toBe('draft-0')
    expect(readCombinedDiffViewMemory('view-1')).toBeUndefined()
    expect(readCombinedDiffViewMemory('view-21')).toBeDefined()
  }
)

it('makes a saved draft evictable again once its view unmounts', () => {
  releaseCombinedDiffView(rememberView(0, { dirty: true }))
  for (let index = 1; index <= 20; index++) {
    releaseCombinedDiffView(rememberView(index, { dirty: true }))
  }
  const saved = claimCombinedDiffView('view-0', 'workspace')
  const view = readCombinedDiffViewMemory('view-0')?.view
  if (!view) {
    throw new Error('missing edited view')
  }
  rememberCombinedDiffView(saved, {
    view: { ...view, sections: view.sections.map((section) => ({ ...section, dirty: false })) }
  })
  expect(readCombinedDiffViewMemory('view-0')).toBeDefined()
  releaseCombinedDiffView(saved)
  expect(readCombinedDiffViewMemory('view-0')).toBeUndefined()
  expect(readCombinedDiffViewMemory('view-1')?.view?.sections[0]?.dirty).toBe(true)
})
