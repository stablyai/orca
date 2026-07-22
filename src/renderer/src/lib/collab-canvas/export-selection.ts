/**
 * Export the current tldraw selection into a bridge selection payload.
 * Editor-facing; unit tests mock a thin Editor surface.
 */

import type { Editor } from '@tldraw/editor'
import type { TLShape } from '@tldraw/tlschema'
import type { CollabCanvasSelectionExport } from './collab-canvas-bridge'

export type CollabSelectionEditor = Pick<
  Editor,
  'getSelectedShapes' | 'getSelectedShapeIds' | 'getSelectionPageBounds' | 'toImageDataUrl'
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
  return `${shape.type}:${shape.id}`
}

/** Build a human digest from selected shapes (no image work). */
export function buildSelectionTextDigest(
  editor: CollabSelectionEditor,
  shapes: readonly TLShape[]
): string {
  if (shapes.length === 0) {
    return '(no shapes selected — full board context not attached)'
  }
  return shapes.map((s) => shapeTextDigest(editor, s)).join('\n')
}

/**
 * Selection → CollabCanvasSelectionExport.
 * When nothing is selected, uses empty ids and null atlas (operator may still
 * send awareness-style digests; call sites can refuse empty selection).
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
    try {
      const image = await editor.toImageDataUrl(shapes, {
        format: 'png',
        background: true,
        padding: 16,
        scale: 1
      })
      atlasDataUri = image.url
    } catch {
      atlasDataUri = null
    }
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
