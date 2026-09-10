import { describe, expect, it } from 'vitest'
import {
  MAESTRO_NOTE_MAX_BYTES,
  createMaestroNoteAtPointer,
  createMaestroUserEdge,
  isMaestroEdgeEditable,
  noteByteCount
} from './maestro-canvas-view-model'

describe('Maestro canvas authoring view model', () => {
  it('counts bounded Markdown bytes rather than UTF-16 units', () => {
    expect(MAESTRO_NOTE_MAX_BYTES).toBe(64 * 1024)
    expect(noteByteCount('á🙂')).toBe(6)
    expect(noteByteCount('a'.repeat(MAESTRO_NOTE_MAX_BYTES))).toBe(MAESTRO_NOTE_MAX_BYTES)
  })

  it('builds truthful authoring edges and keeps projected edges read-only', () => {
    expect(
      createMaestroUserEdge({
        id: 'edge-1',
        sourceId: 'note-1',
        targetId: 'task-1',
        type: 'reports_to'
      })
    ).toEqual({
      kind: 'create-edge',
      id: 'edge-1',
      source_id: 'note-1',
      target_id: 'task-1',
      type: 'reports_to',
      direction: 'forward'
    })
    expect(isMaestroEdgeEditable({ projected: false })).toBe(true)
    expect(isMaestroEdgeEditable({ projected: true })).toBe(false)
  })

  it('rejects invalid typed context edges', () => {
    expect(() =>
      createMaestroUserEdge({
        id: 'edge-2',
        sourceId: 'note-1',
        targetId: 'note-1',
        type: 'context_for',
        contextNoteId: 'note-1',
        expectedNoteRevision: 1
      })
    ).toThrow('A Maestro edge needs two endpoints.')
    expect(() =>
      createMaestroUserEdge({
        id: 'edge-3',
        sourceId: 'note-1',
        targetId: 'task-1',
        type: 'context_for'
      })
    ).toThrow('Context links need an expected note revision.')
  })

  it('places a note at the clicked world coordinate', () => {
    const note = createMaestroNoteAtPointer({
      title: ' Context ',
      markdown: '# Context',
      pointer: { x: 150, y: 100 },
      viewport: { center: { x: 0, y: 0 }, zoom: 1 },
      canvas: { width: 300, height: 200 }
    })
    expect(note).toMatchObject({
      kind: 'note',
      title: 'Context',
      position: { x: 0, y: 0 },
      note_revision: 1
    })
  })
})
