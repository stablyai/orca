import type { AntigravitySwarmMemberTranscriptEntry } from './antigravity-swarm-transcript'

export { buildAntigravitySwarmSnapshot } from './antigravity-swarm-snapshot'
export {
  parseAntigravityMemberTranscript,
  summarizeAntigravityTranscript,
  type AntigravitySwarmMemberTranscriptEntry,
  type AntigravitySwarmToolCallSummary,
  type AntigravitySwarmTranscriptSummary
} from './antigravity-swarm-transcript'

export type AntigravitySwarmMemberStatus = 'working' | 'waiting' | 'killed'

export type AntigravitySwarmMemberFailure = {
  kind: 'quota' | 'error'
  text: string
}

export type AntigravitySwarmMember = {
  name: string
  conversationId: string
  model: string
  role: string
  wakeMode: string
  status: AntigravitySwarmMemberStatus
  waitSince: number
  lastReadSeq: number
  unread: number
  killed: boolean
  worktree: string | null
  channels: string[]
  steps: number
  activity: string
  activityKind: 'tool' | 'thinking' | ''
  replied: boolean
  failure: AntigravitySwarmMemberFailure | null
  posts: number
  lastPostSeq: number
  lastPostTime: string
  lastPostTs: number | null
  transcriptMtime: number
}

export type AntigravitySwarmPost = {
  seq: number
  agent: string
  text: string
  time: string
  ts: number | null
  mentions: string[]
  all: boolean
  channel?: string
  kind?: string
  requestId?: string
  control?: Record<string, unknown>
}

export type AntigravitySwarmPlanStep = {
  title: string
  status?: string
  owner?: string
  detail?: string
}

export type AntigravitySwarmPlan = {
  goal?: { title?: string; line?: string }
  steps?: AntigravitySwarmPlanStep[]
}

export type AntigravitySwarmSnapshot = {
  swarmId: string
  title: string
  headSeq: number
  channels: string[]
  members: AntigravitySwarmMember[]
  messages: AntigravitySwarmPost[]
  plan: AntigravitySwarmPlan | null
  etag: string
}

export type AgentSessionSwarmReadResult =
  | { status: 'ok'; snapshot: AntigravitySwarmSnapshot }
  | { status: 'unchanged'; etag: string }
  | { status: 'none' }
  | { status: 'unsupported' }
  | { status: 'failed'; message: string | null }

export type AgentSessionSwarmTranscriptResult =
  | {
      status: 'ok'
      conversationId: string
      entries: AntigravitySwarmMemberTranscriptEntry[]
      truncated: boolean
    }
  | { status: 'none' }
  | { status: 'unsupported' }
  | { status: 'failed'; message: string | null }
