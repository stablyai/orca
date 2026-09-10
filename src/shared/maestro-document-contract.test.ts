import { describe, expect, it } from 'vitest'
import { WorkspaceCanvasDocumentSchema } from './maestro-document-contract'
import {
  emptyWorkspaceCanvasDocument,
  workspaceSuggestionState
} from './maestro-workspace-document-state'

describe('workspace Canvas document', () => {
  it('persists only layout, manual links, suggestion decisions, and bounded preferences', () => {
    const document = emptyWorkspaceCanvasDocument()
    expect(WorkspaceCanvasDocumentSchema.parse(document)).toEqual(document)
    expect(() =>
      WorkspaceCanvasDocumentSchema.parse({ ...document, terminal_output: 'secret output' })
    ).toThrow()
    expect(() =>
      WorkspaceCanvasDocumentSchema.parse({ ...document, editor_buffer: 'dirty' })
    ).toThrow()
    expect(() => WorkspaceCanvasDocumentSchema.parse({ ...document, browser_page: {} })).toThrow()
  })

  it('keeps changed suggestion evidence pending instead of rewriting a decision', () => {
    const document = emptyWorkspaceCanvasDocument()
    document.suggestion_decisions['suggestion-1'] = {
      fingerprint: 'suggestion-1',
      suggestion_revision: 2,
      state: 'hidden',
      decided_by: 'user-1',
      decided_at: '2026-08-25T12:00:00.000Z',
      accepted_link: null
    }
    expect(workspaceSuggestionState({ fingerprint: 'suggestion-1', revision: 2 }, document)).toBe(
      'hidden'
    )
    expect(workspaceSuggestionState({ fingerprint: 'suggestion-1', revision: 3 }, document)).toBe(
      'pending'
    )
  })
})
