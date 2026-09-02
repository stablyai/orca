import { describe, expect, it } from 'vitest'
import type { OpenFile } from '../../store/slices/editor'
import { STATUS_COLORS, STATUS_LABELS } from '../right-sidebar/status-display'
import { getCollapsedEditorTabState } from './collapsed-editor-tab-state'

function file(overrides: Partial<OpenFile> = {}): Pick<OpenFile, 'isDirty' | 'externalMutation'> {
  return { isDirty: false, ...overrides }
}

/**
 * Collapsing a pinned editor tab removes the label that carried its status letter, mutation badge
 * and strikethrough, so anything not recovered here is state the user silently stops seeing.
 */
describe('getCollapsedEditorTabState', () => {
  it('reports nothing for a clean, unmodified file', () => {
    expect(
      getCollapsedEditorTabState({ file: file(), tabStatus: null, tabLabel: 'README.md' })
    ).toEqual({
      dotColor: null,
      stateLabel: null,
      title: 'README.md'
    })
  })

  it('recovers the git status letter and its colour', () => {
    expect(
      getCollapsedEditorTabState({ file: file(), tabStatus: 'modified', tabLabel: 'README.md' })
    ).toEqual({
      dotColor: STATUS_COLORS.modified,
      stateLabel: STATUS_LABELS.modified,
      title: `README.md (${STATUS_LABELS.modified})`
    })
  })

  it.each(['deleted', 'renamed'] as const)(
    'reports a %s file, outranking git status',
    (mutation) => {
      expect(
        getCollapsedEditorTabState({
          file: file({ externalMutation: mutation }),
          tabStatus: 'modified',
          tabLabel: 'README.md'
        })
      ).toEqual({ dotColor: null, stateLabel: mutation, title: `README.md (${mutation})` })
    }
  )

  // Regression: an early return on tabStatus used to shadow isDirty, so a modified file with
  // unsaved edits reported only "(M)" and the collapsed tab silently dropped the dirty state.
  it('keeps unsaved changes alongside a git status', () => {
    const state = getCollapsedEditorTabState({
      file: file({ isDirty: true }),
      tabStatus: 'modified',
      tabLabel: 'README.md'
    })

    expect(state.stateLabel).toBe(`${STATUS_LABELS.modified}, unsaved`)
    expect(state.title).toBe(`README.md (${STATUS_LABELS.modified}, unsaved)`)
    expect(state.dotColor).toBe(STATUS_COLORS.modified)
  })

  it('keeps unsaved changes alongside an external mutation', () => {
    const state = getCollapsedEditorTabState({
      file: file({ isDirty: true, externalMutation: 'deleted' }),
      tabStatus: 'modified',
      tabLabel: 'README.md'
    })

    expect(state.stateLabel).toBe('deleted, unsaved')
    expect(state.title).toBe('README.md (deleted, unsaved)')
  })

  it('falls back to unsaved changes when git has nothing to say', () => {
    expect(
      getCollapsedEditorTabState({
        file: file({ isDirty: true }),
        tabStatus: null,
        tabLabel: 'README.md'
      })
    ).toEqual({
      dotColor: null,
      stateLabel: 'unsaved',
      title: 'README.md (unsaved)'
    })
  })
})
