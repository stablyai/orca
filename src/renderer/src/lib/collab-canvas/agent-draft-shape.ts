/**
 * agent-draft custom shape — tldraw shape util registration helpers.
 *
 * The pure props live in collab-canvas-bridge.ts. This module owns the shape
 * type id constant and the default props factory used when mounting drafts on
 * a live editor (desktop CollabCanvas or mobile WebView engine).
 */

import {
  buildAgentDraftShapeProps,
  type AgentDraftShapeProps,
  type AgentReplyForDraft
} from './collab-canvas-bridge'

export const AGENT_DRAFT_SHAPE_TYPE = 'agent-draft' as const

export type { AgentDraftShapeProps }

/** Default props for a brand-new provisional draft shape on the canvas. */
export function defaultAgentDraftProps(reply: AgentReplyForDraft): AgentDraftShapeProps {
  return buildAgentDraftShapeProps(reply)
}

/**
 * Whether a shape record from the store is an agent-draft (provisional layer).
 * Freehand `draw` / `geo` shapes must never match.
 */
export function isAgentDraftRecord(record: { type?: string; typeName?: string } | null): boolean {
  if (!record) return false
  return record.type === AGENT_DRAFT_SHAPE_TYPE || record.typeName === AGENT_DRAFT_SHAPE_TYPE
}

/** Serializable createShape partial for a live editor (no tldraw import). */
export type AgentDraftCreateShapePartial = {
  type: typeof AGENT_DRAFT_SHAPE_TYPE
  x: number
  y: number
  props: {
    w: number
    h: number
    draftId: string
    boardId: string
    body: string
    status: AgentDraftShapeProps['status']
    sourceTurnId: string
    label: string
    createdAt: number
  }
}

/**
 * Pure reply → createShape args. Kept free of `tldraw` so unit tests do not
 * pull the tiptap peer graph that ShapeUtil imports require.
 */
export function buildAgentDraftCreateShapePartial(reply: AgentReplyForDraft): {
  draft: AgentDraftShapeProps
  shape: AgentDraftCreateShapePartial
} {
  const draft = buildAgentDraftShapeProps(reply)
  return {
    draft,
    shape: {
      type: AGENT_DRAFT_SHAPE_TYPE,
      x: draft.x,
      y: draft.y,
      props: {
        w: draft.w,
        h: draft.h,
        draftId: draft.draftId,
        boardId: draft.boardId,
        body: draft.body,
        status: draft.status,
        sourceTurnId: draft.sourceTurnId ?? '',
        label: draft.visual.label,
        createdAt: draft.createdAt
      }
    }
  }
}
