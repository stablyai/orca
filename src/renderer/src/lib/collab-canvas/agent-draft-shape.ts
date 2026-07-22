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
