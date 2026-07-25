/**
 * Export board + optional selection into a bridge payload for session inject.
 *
 * Operator ask (G2-P follow-up): every Send ships a **full board screenshot**
 * so a vision model sees the whole surface, plus selection coords/digest when
 * the operator highlighted ink (focus, not the only visual).
 */

import type { Editor } from '@tldraw/editor'
import type { TLShape } from '@tldraw/tlschema'
import type { CollabCanvasSelectionExport } from './collab-canvas-bridge'

export type CollabSelectionEditor = Pick<
  Editor,
  | 'getSelectedShapes'
  | 'getSelectedShapeIds'
  | 'getSelectionPageBounds'
  | 'getCurrentPageShapes'
  | 'toImageDataUrl'
> & {
  getShapeUtil?(shape: TLShape): { getText?(shape: TLShape): string | undefined } | undefined
}

function shapeTextDigest(editor: CollabSelectionEditor, shape: TLShape): string {
  try {
    const text = editor.getShapeUtil?.(shape)?.getText?.(shape)
    if (text?.trim()) {
      return `${shape.type}:${shape.id}: ${text.trim().slice(0, 200)}`
    }
  } catch {
    // ignore util failures
  }
  const x = Math.round((shape as { x?: number }).x ?? 0)
  const y = Math.round((shape as { y?: number }).y ?? 0)
  return `${shape.type}:${shape.id} @${x},${y}`
}

/** Build a human digest from shapes (no image work). */
export function buildSelectionTextDigest(
  editor: CollabSelectionEditor,
  shapes: readonly TLShape[]
): string {
  if (shapes.length === 0) {
    return '(no shapes)'
  }
  return shapes.map((s) => shapeTextDigest(editor, s)).join('\n')
}

export type CollabBoardExport = CollabCanvasSelectionExport & {
  /** PNG of the whole page (all shapes). Primary vision payload. */
  boardAtlasDataUri: string | null
  /** All shapes on the page (coords digest). */
  boardShapeIds: readonly string[]
  boardTextDigest: string
  /** True when the operator had a non-empty selection at export time. */
  hasSelection: boolean
}

async function exportPng(
  editor: CollabSelectionEditor,
  shapes: readonly TLShape[]
): Promise<string | null> {
  if (shapes.length === 0) {
    return null
  }
  try {
    const image = await editor.toImageDataUrl(shapes, {
      format: 'png',
      background: true,
      padding: 24,
      scale: 1
    })
    return image.url
  } catch {
    return null
  }
}

/**
 * Full board snapshot (+ optional selection crop/coords) for session inject.
 * Always attempts a whole-page atlas when any shapes exist.
 */
export async function exportCollabBoardFromEditor(
  editor: CollabSelectionEditor,
  opts: {
    boardId: string
    worktreeId: string
    includeBoardAtlas?: boolean
    includeSelectionAtlas?: boolean
  }
): Promise<CollabBoardExport> {
  const pageShapes = editor.getCurrentPageShapes()
  const selectedShapes = editor.getSelectedShapes()
  const selectedShapeIds = editor.getSelectedShapeIds().map(String)
  const hasSelection = selectedShapes.length > 0
  const boundsBox = hasSelection ? editor.getSelectionPageBounds() : null
  const bounds = boundsBox
    ? {
        x: boundsBox.x,
        y: boundsBox.y,
        w: boundsBox.w,
        h: boundsBox.h
      }
    : null

  const includeBoard = opts.includeBoardAtlas !== false
  const includeSel = opts.includeSelectionAtlas !== false

  const boardAtlasDataUri = includeBoard ? await exportPng(editor, pageShapes) : null
  // Selection crop is secondary focus; skip if identical to full board (all selected).
  let selectionAtlas: string | null = null
  if (includeSel && hasSelection) {
    const allSelected =
      pageShapes.length > 0 && selectedShapes.length === pageShapes.length
    if (!allSelected) {
      selectionAtlas = await exportPng(editor, selectedShapes)
    }
  }

  // Primary atlas field = board overview (vision default).
  return {
    boardId: opts.boardId,
    worktreeId: opts.worktreeId,
    textDigest: hasSelection
      ? buildSelectionTextDigest(editor, selectedShapes)
      : '(no selection — using full board)',
    atlasDataUri: boardAtlasDataUri,
    boardAtlasDataUri,
    boardShapeIds: pageShapes.map((s) => String(s.id)),
    boardTextDigest: buildSelectionTextDigest(editor, pageShapes),
    hasSelection,
    bounds,
    selectedShapeIds,
    selectionAtlasDataUri: selectionAtlas
  }
}

/**
 * @deprecated Prefer exportCollabBoardFromEditor — kept for unit tests that
 * only exercise selection atlas.
 */
export async function exportCollabSelectionFromEditor(
  editor: CollabSelectionEditor,
  opts: { boardId: string; worktreeId: string; includeAtlas?: boolean }
): Promise<CollabCanvasSelectionExport> {
  const shapes = editor.getSelectedShapes()
  const selectedShapeIds = editor.getSelectedShapeIds().map(String)
  const boundsBox = editor.getSelectionPageBounds()
  const bounds = boundsBox
    ? {
        x: boundsBox.x,
        y: boundsBox.y,
        w: boundsBox.w,
        h: boundsBox.h
      }
    : null

  let atlasDataUri: string | null = null
  if (opts.includeAtlas !== false && shapes.length > 0) {
    atlasDataUri = await exportPng(editor, shapes)
  }

  return {
    boardId: opts.boardId,
    worktreeId: opts.worktreeId,
    textDigest: buildSelectionTextDigest(editor, shapes),
    atlasDataUri,
    bounds,
    selectedShapeIds
  }
}
