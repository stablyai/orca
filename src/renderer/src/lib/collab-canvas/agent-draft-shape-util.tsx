/**
 * Live tldraw ShapeUtil for agent-draft — provisional agent replies on the board.
 * Visually distinct from freehand (dashed frame + accent label).
 */
import { HTMLContainer, Rectangle2d, ShapeUtil, type Editor } from '@tldraw/editor'
import { T } from '@tldraw/validate'
import type { RecordProps, TLShape } from '@tldraw/tlschema'
import {
  AGENT_DRAFT_SHAPE_TYPE,
  buildAgentDraftCreateShapePartial,
  type AgentDraftShapeProps as BridgeDraftProps
} from './agent-draft-shape'
import type { AgentReplyForDraft } from './collab-canvas-bridge'

declare module 'tldraw' {
  interface TLGlobalShapePropsMap {
    [AGENT_DRAFT_SHAPE_TYPE]: {
      w: number
      h: number
      draftId: string
      boardId: string
      body: string
      status: 'provisional' | 'accepted' | 'rejected'
      sourceTurnId: string
      label: string
      createdAt: number
    }
  }
}

export type TLAgentDraftShape = TLShape<typeof AGENT_DRAFT_SHAPE_TYPE>

export const agentDraftShapeProps: RecordProps<TLAgentDraftShape> = {
  w: T.nonZeroNumber,
  h: T.nonZeroNumber,
  draftId: T.string,
  boardId: T.string,
  body: T.string,
  status: T.literalEnum('provisional', 'accepted', 'rejected'),
  sourceTurnId: T.string,
  label: T.string,
  createdAt: T.number
}

export class AgentDraftShapeUtil extends ShapeUtil<TLAgentDraftShape> {
  static override type = AGENT_DRAFT_SHAPE_TYPE
  static override props = agentDraftShapeProps

  getDefaultProps(): TLAgentDraftShape['props'] {
    return {
      w: 280,
      h: 160,
      draftId: 'draft-unset',
      boardId: '',
      body: '',
      status: 'provisional',
      sourceTurnId: '',
      label: 'Agent draft',
      createdAt: 0
    }
  }

  getGeometry(shape: TLAgentDraftShape) {
    return new Rectangle2d({
      width: shape.props.w,
      height: shape.props.h,
      isFilled: true
    })
  }

  component(shape: TLAgentDraftShape) {
    const { body, label, status } = shape.props
    const border =
      status === 'provisional'
        ? '2px dashed #7c3aed'
        : status === 'accepted'
          ? '2px solid #16a34a'
          : '2px solid #dc2626'
    const bg =
      status === 'provisional'
        ? 'rgba(124, 58, 237, 0.08)'
        : status === 'accepted'
          ? 'rgba(22, 163, 74, 0.08)'
          : 'rgba(220, 38, 38, 0.08)'

    return (
      <HTMLContainer
        style={{
          width: shape.props.w,
          height: shape.props.h,
          border,
          background: bg,
          borderRadius: 8,
          padding: 10,
          boxSizing: 'border-box',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          pointerEvents: 'all',
          fontFamily: 'ui-sans-serif, system-ui, sans-serif'
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: 0.02,
            color: status === 'provisional' ? '#7c3aed' : status === 'accepted' ? '#16a34a' : '#dc2626',
            textTransform: 'uppercase'
          }}
        >
          {label}
        </div>
        <div
          style={{
            fontSize: 13,
            lineHeight: 1.35,
            color: 'var(--tl-color-text, #111)',
            whiteSpace: 'pre-wrap',
            overflow: 'auto',
            flex: 1
          }}
        >
          {body}
        </div>
      </HTMLContainer>
    )
  }

  getIndicatorPath(shape: TLAgentDraftShape) {
    const path = new Path2D()
    path.rect(0, 0, shape.props.w, shape.props.h)
    return path
  }
}

/** Register with <Tldraw shapeUtils={COLLAB_CANVAS_SHAPE_UTILS} />. */
export const COLLAB_CANVAS_SHAPE_UTILS = [AgentDraftShapeUtil] as const

/** Create an agent-draft shape on a live editor from a bridge reply. */
export function mountAgentDraftOnEditor(
  editor: Pick<Editor, 'createShape'>,
  reply: AgentReplyForDraft
): BridgeDraftProps {
  const { draft, shape } = buildAgentDraftCreateShapePartial(reply)
  try {
    editor.createShape(shape)
  } catch (err) {
    // Surface schema misconfig clearly — ValidationError on unknown type means
    // useSync/Tldraw was built without AgentDraftShapeUtil in the store schema.
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(
      msg.includes('agent-draft')
        ? `agent-draft shape rejected by store schema (register AgentDraftShapeUtil on useSync): ${msg}`
        : msg,
      { cause: err instanceof Error ? err : undefined }
    )
  }
  return draft
}
