/**
 * Apply parsed collab-board ops onto a live tldraw editor.
 * Geo/note use stock shapes; draft uses agent-draft util.
 */

import type { Editor } from '@tldraw/editor'
import { mountAgentDraftOnEditor } from './agent-draft-shape-util'
import type { CollabBoardOp } from './parse-agent-board-ops'

/** Minimal rich-text doc for stock geo/note labels (avoids importing tldraw root). */
function plainRichText(text: string): {
  type: 'doc'
  content: Array<{ type: 'paragraph'; content?: Array<{ type: 'text'; text: string }> }>
} {
  const trimmed = text.trim()
  if (!trimmed) {
    return { type: 'doc', content: [{ type: 'paragraph' }] }
  }
  return {
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: trimmed }] }]
  }
}

export type ApplyAgentBoardOpsResult = {
  applied: number
  drafts: number
  geos: number
  notes: number
}

export function applyAgentBoardOps(
  editor: Pick<Editor, 'createShape'>,
  boardId: string,
  ops: readonly CollabBoardOp[]
): ApplyAgentBoardOpsResult {
  let drafts = 0
  let geos = 0
  let notes = 0
  let stackY = 40

  for (const op of ops) {
    if (op.op === 'draft') {
      const x = op.x ?? 40
      const y = op.y ?? stackY
      mountAgentDraftOnEditor(editor, {
        boardId,
        body: op.body,
        placement: { x, y, w: op.w, h: op.h },
        sourceTurnId: 'collab-board-op'
      })
      drafts += 1
      stackY = y + (op.h ?? 160) + 24
      continue
    }

    if (op.op === 'geo') {
      editor.createShape({
        type: 'geo',
        x: op.x,
        y: op.y,
        props: {
          geo: op.geo,
          w: op.w,
          h: op.h,
          // tldraw geo label is richText in v5
          richText: plainRichText(op.label ?? '')
        }
      } as never)
      geos += 1
      stackY = Math.max(stackY, op.y + op.h + 24)
      continue
    }

    if (op.op === 'note') {
      editor.createShape({
        type: 'note',
        x: op.x,
        y: op.y,
        props: {
          richText: plainRichText(op.text)
        }
      } as never)
      notes += 1
      stackY = Math.max(stackY, op.y + 120)
    }
  }

  return {
    applied: drafts + geos + notes,
    drafts,
    geos,
    notes
  }
}
