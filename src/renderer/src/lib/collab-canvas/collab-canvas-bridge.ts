/**
 * collab-canvas-bridge — pure atlas → inject payload → agent-draft transforms.
 *
 * Session boards never spawn a second agent. Selection becomes a terminal inject
 * payload (PNG atlas + text digest); agent replies become `agent-draft` shape
 * props that the board mounts as a visually distinct provisional layer until
 * the operator accepts them into confirmed ink.
 *
 * All functions here are pure so unit tests can drive the real entry points
 * without Electron, tldraw, or a live PTY.
 */

export type CollabCanvasSelectionExport = {
  /** Board id (sync room key). */
  boardId: string
  /** Worktree that owns the session board (and its terminal agent). */
  worktreeId: string
  /** Human-readable digest of selected shapes / notes. */
  textDigest: string
  /** Optional PNG (or other image) atlas as a data URI or base64 payload. */
  atlasDataUri: string | null
  /** Optional bounding box of the selection in page space. */
  bounds: { x: number; y: number; w: number; h: number } | null
  selectedShapeIds: readonly string[]
}

/** What we hand the terminal inject path for a session board. */
export type CollabCanvasInjectPayload = {
  kind: 'collab-canvas-inject'
  boardId: string
  worktreeId: string
  /** Bracketed multi-line text ready for paste into the agent terminal. */
  terminalText: string
  /** Atlas accompanies multimodal agents; null when export was text-only. */
  atlasDataUri: string | null
  /** True when a second agent must NOT be spawned (session boards always). */
  usesExistingSessionAgent: true
}

export type AgentDraftStatus = 'provisional' | 'accepted' | 'rejected'

/** Props for the custom tldraw `agent-draft` shape (serializable, no React). */
export type AgentDraftShapeProps = {
  typeName: 'agent-draft'
  draftId: string
  boardId: string
  /** Reply body shown on the board. */
  body: string
  status: AgentDraftStatus
  /** Source message id / turn marker when known. */
  sourceTurnId: string | null
  /** Page-space placement. */
  x: number
  y: number
  w: number
  h: number
  /** Visual distinction from freehand ink: dashed provisional frame. */
  visual: {
    strokeStyle: 'dashed'
    fill: 'none'
    label: 'Agent draft'
    /** CSS-ish accent token; UI maps to theme. */
    accent: 'agent-draft'
  }
  createdAt: number
}

export type AgentReplyForDraft = {
  boardId: string
  body: string
  sourceTurnId?: string | null
  /** Optional placement hint; defaults near origin with a readable size. */
  placement?: { x: number; y: number; w?: number; h?: number }
  createdAt?: number
  draftId?: string
}

const DEFAULT_DRAFT_W = 280
const DEFAULT_DRAFT_H = 160

/** Build the text an agent terminal receives for a board selection. */
export function buildCollabCanvasInjectText(selection: CollabCanvasSelectionExport): string {
  const lines = [
    '[collab-canvas]',
    `board: ${selection.boardId}`,
    `worktree: ${selection.worktreeId}`,
    `shapes: ${selection.selectedShapeIds.length}`,
    selection.bounds
      ? `bounds: ${Math.round(selection.bounds.x)},${Math.round(selection.bounds.y)} ${Math.round(selection.bounds.w)}×${Math.round(selection.bounds.h)}`
      : 'bounds: (none)',
    selection.atlasDataUri ? 'atlas: attached (image)' : 'atlas: none',
    '--- selection digest ---',
    selection.textDigest.trim() || '(empty selection)',
    '--- end collab-canvas ---'
  ]
  return lines.join('\n')
}

/**
 * Selection → inject payload for the worktree's live agent terminal.
 * Session boards always set usesExistingSessionAgent.
 */
export function buildCollabCanvasInjectPayload(
  selection: CollabCanvasSelectionExport
): CollabCanvasInjectPayload {
  if (!selection.boardId.trim()) {
    throw new Error('buildCollabCanvasInjectPayload: boardId required')
  }
  if (!selection.worktreeId.trim()) {
    throw new Error('buildCollabCanvasInjectPayload: worktreeId required')
  }
  return {
    kind: 'collab-canvas-inject',
    boardId: selection.boardId,
    worktreeId: selection.worktreeId,
    terminalText: buildCollabCanvasInjectText(selection),
    atlasDataUri: selection.atlasDataUri,
    usesExistingSessionAgent: true
  }
}

/** Agent reply → provisional agent-draft shape props (not freehand ink). */
export function buildAgentDraftShapeProps(reply: AgentReplyForDraft): AgentDraftShapeProps {
  if (!reply.boardId.trim()) {
    throw new Error('buildAgentDraftShapeProps: boardId required')
  }
  const body = reply.body.trim()
  if (!body) {
    throw new Error('buildAgentDraftShapeProps: body required')
  }
  const placement = reply.placement ?? { x: 40, y: 40 }
  return {
    typeName: 'agent-draft',
    draftId: reply.draftId ?? `draft-${reply.createdAt ?? Date.now()}`,
    boardId: reply.boardId,
    body,
    status: 'provisional',
    sourceTurnId: reply.sourceTurnId ?? null,
    x: placement.x,
    y: placement.y,
    w: placement.w ?? DEFAULT_DRAFT_W,
    h: placement.h ?? DEFAULT_DRAFT_H,
    visual: {
      strokeStyle: 'dashed',
      fill: 'none',
      label: 'Agent draft',
      accent: 'agent-draft'
    },
    createdAt: reply.createdAt ?? Date.now()
  }
}

/** Accept a provisional draft into "confirmed" status (still not freehand). */
export function acceptAgentDraft(props: AgentDraftShapeProps): AgentDraftShapeProps {
  if (props.status !== 'provisional') {
    throw new Error(`acceptAgentDraft: expected provisional, got ${props.status}`)
  }
  return {
    ...props,
    status: 'accepted',
    visual: {
      ...props.visual,
      strokeStyle: 'dashed',
      label: 'Agent draft (accepted)'
    }
  }
}

/** Reject a provisional draft. */
export function rejectAgentDraft(props: AgentDraftShapeProps): AgentDraftShapeProps {
  if (props.status !== 'provisional') {
    throw new Error(`rejectAgentDraft: expected provisional, got ${props.status}`)
  }
  return {
    ...props,
    status: 'rejected',
    visual: {
      ...props.visual,
      label: 'Agent draft (rejected)'
    }
  }
}

/** Freehand / geo shapes are never agent-drafts — used by UI filters. */
export function isAgentDraftShapeType(typeName: string): boolean {
  return typeName === 'agent-draft'
}
