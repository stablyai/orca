import { describe, expect, it } from 'vitest'
import {
  acceptAgentDraft,
  buildAgentDraftShapeProps,
  buildCollabCanvasInjectPayload,
  buildCollabCanvasInjectText,
  isAgentDraftShapeType,
  rejectAgentDraft,
  type CollabCanvasSelectionExport
} from './collab-canvas-bridge'

const selection: CollabCanvasSelectionExport = {
  boardId: 'board-1',
  worktreeId: 'wt-1',
  textDigest: 'draw a red box around the login form',
  atlasDataUri: 'data:image/png;base64,abc',
  bounds: { x: 10, y: 20, w: 100, h: 50 },
  selectedShapeIds: ['shape:a', 'shape:b']
}

describe('buildCollabCanvasInjectText', () => {
  it('embeds full-board screenshot path plus selection focus', () => {
    const text = buildCollabCanvasInjectText(
      {
        ...selection,
        hasSelection: true,
        boardTextDigest: 'draw:shape:a @1,2\ndraw:shape:b @3,4',
        boardShapeIds: ['shape:a', 'shape:b']
      },
      {
        boardFilePath: '/tmp/orca-paste-board.png',
        selectionFilePath: '/tmp/orca-paste-sel.png'
      }
    )
    expect(text).toContain('OPERATOR — collab board update')
    expect(text).toContain('Board id: board-1')
    expect(text).toContain('Worktree: wt-1')
    expect(text).toContain('Board screenshot (open this path — full page): /tmp/orca-paste-board.png')
    expect(text).toContain('Selection crop (optional focus image): /tmp/orca-paste-sel.png')
    expect(text).toContain('draw a red box around the login form')
    expect(text).toContain('Selected shapes: 2')
    expect(text).toContain('agent-draft')
    expect(text).not.toContain('[collab-canvas]')
  })

  it('marks missing board screenshot explicitly', () => {
    const text = buildCollabCanvasInjectText({
      ...selection,
      atlasDataUri: null,
      hasSelection: false
    })
    expect(text).toContain('Board screenshot: none')
    expect(text).toContain('No selection')
  })
})

describe('buildCollabCanvasInjectPayload', () => {
  it('builds a session inject that reuses the terminal agent', () => {
    const payload = buildCollabCanvasInjectPayload(selection, {
      boardFilePath: '/tmp/atlas.png'
    })
    expect(payload.kind).toBe('collab-canvas-inject')
    expect(payload.usesExistingSessionAgent).toBe(true)
    expect(payload.boardId).toBe('board-1')
    expect(payload.worktreeId).toBe('wt-1')
    expect(payload.atlasDataUri).toBe(selection.atlasDataUri)
    expect(payload.terminalText).toContain('/tmp/atlas.png')
    expect(payload.terminalText).toContain('Board screenshot')
  })

  it('rejects empty board or worktree ids', () => {
    expect(() => buildCollabCanvasInjectPayload({ ...selection, boardId: '  ' })).toThrow(
      /boardId/
    )
    expect(() => buildCollabCanvasInjectPayload({ ...selection, worktreeId: '' })).toThrow(
      /worktreeId/
    )
  })
})

describe('buildAgentDraftShapeProps', () => {
  it('creates a provisional draft distinct from freehand ink', () => {
    const draft = buildAgentDraftShapeProps({
      boardId: 'board-1',
      body: 'Here is a proposed layout.',
      sourceTurnId: 'turn-9',
      placement: { x: 12, y: 34 },
      createdAt: 1_700_000_000_000,
      draftId: 'draft-fixed'
    })
    expect(draft.typeName).toBe('agent-draft')
    expect(draft.status).toBe('provisional')
    expect(draft.visual.strokeStyle).toBe('dashed')
    expect(draft.visual.label).toBe('Agent draft')
    expect(draft.visual.accent).toBe('agent-draft')
    expect(draft.visual.fill).toBe('none')
    expect(draft.body).toBe('Here is a proposed layout.')
    expect(draft.sourceTurnId).toBe('turn-9')
    expect(draft.x).toBe(12)
    expect(draft.y).toBe(34)
    expect(isAgentDraftShapeType(draft.typeName)).toBe(true)
    expect(isAgentDraftShapeType('geo')).toBe(false)
    expect(isAgentDraftShapeType('draw')).toBe(false)
  })

  it('rejects empty body', () => {
    expect(() => buildAgentDraftShapeProps({ boardId: 'b', body: '  ' })).toThrow(/body/)
  })
})

describe('accept / reject agent draft', () => {
  it('moves provisional → accepted without becoming freehand', () => {
    const draft = buildAgentDraftShapeProps({ boardId: 'b', body: 'ok', draftId: 'd1' })
    const accepted = acceptAgentDraft(draft)
    expect(accepted.status).toBe('accepted')
    expect(accepted.typeName).toBe('agent-draft')
    expect(accepted.visual.label).toMatch(/accepted/)
  })

  it('moves provisional → rejected', () => {
    const draft = buildAgentDraftShapeProps({ boardId: 'b', body: 'nope', draftId: 'd2' })
    const rejected = rejectAgentDraft(draft)
    expect(rejected.status).toBe('rejected')
    expect(rejected.typeName).toBe('agent-draft')
  })

  it('refuses double-accept', () => {
    const draft = buildAgentDraftShapeProps({ boardId: 'b', body: 'x', draftId: 'd3' })
    const accepted = acceptAgentDraft(draft)
    expect(() => acceptAgentDraft(accepted)).toThrow(/provisional/)
  })
})
