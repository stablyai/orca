import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

export const LOCAL: RuntimeClientTarget = { kind: 'local' }

export const ORCA_SESSION_PREFIX = 'orca_session_id:'

export type RoomMember = {
  memberId: string
  name: string
  isAdmin: boolean
  status?: 'idle' | 'working' | 'waiting' | 'failed'
  statusUpdatedAt?: string
  sessionId?: string | null
}

export type Room = {
  id: string
  name: string
  mode: 'admin' | 'everyone'
  adminMemberId: string | null
  notice: string
  seq?: number
  latestLine?: RoomPreviewLine | null
  members: RoomMember[]
}

export type RoomLine = {
  seq: number
  who: string
  memberId: string | null
  text: string
  kind: string | null
  targetMemberId?: string | null
  createdAt: string
}

export type RoomPreviewLine = Pick<RoomLine, 'who' | 'text' | 'createdAt'> & {
  memberId: string | null
}

export type AgentSessionOption = { sessionId: string; label: string; worktreeId: string }

export const BOT_AGENTS = [
  { id: 'codex', label: 'Codex' },
  { id: 'claude', label: 'Claude' },
  { id: 'pi', label: 'Pi' },
  { id: 'grok', label: 'Grok' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'opencode2', label: 'OpenCode 2' },
  { id: 'omp', label: 'OMP' },
  { id: 'antigravity', label: 'Antigravity' }
] as const
