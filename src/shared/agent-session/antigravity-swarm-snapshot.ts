import type {
  AntigravitySwarmMember,
  AntigravitySwarmPlan,
  AntigravitySwarmPlanStep,
  AntigravitySwarmPost,
  AntigravitySwarmSnapshot
} from './antigravity-swarm-wire'
import { isRecord, type AntigravitySwarmTranscriptSummary } from './antigravity-swarm-transcript'

type RawMember = Record<string, unknown>

const MAIN_CHANNEL = 'main'
export const STEP_ERROR_SETTLE_MS = 10_000
const QUOTA_ERROR_RE = /\b(quota|rate\s*limit|resource_exhausted|429|exhausted)\b/i

function parseRawRoster(
  membersJson: string
): { title: string; members: Record<string, RawMember> } | null {
  if (!membersJson.trim()) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(membersJson)
    if (!isRecord(parsed)) {
      return null
    }
    const members: Record<string, RawMember> = {}
    if (isRecord(parsed.members)) {
      for (const [name, entry] of Object.entries(parsed.members)) {
        if (isRecord(entry)) {
          members[name] = entry
        }
      }
    }
    return {
      title: typeof parsed.title === 'string' ? parsed.title : '',
      members
    }
  } catch {
    return null
  }
}

function parseRawBoard(boardJsonl: string): Record<string, unknown>[] {
  if (!boardJsonl.trim()) {
    return []
  }
  const rows: Record<string, unknown>[] = []
  for (const line of boardJsonl.split('\n')) {
    if (!line.trim()) {
      continue
    }
    try {
      const parsed: unknown = JSON.parse(line)
      if (isRecord(parsed)) {
        rows.push(parsed)
      }
    } catch {
      // A torn final line settles on the next read.
    }
  }
  return rows
}

function parseRawPlan(planJson: string | null | undefined): AntigravitySwarmPlan | null {
  if (!planJson?.trim()) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(planJson)
    if (!isRecord(parsed)) {
      return null
    }
    const goal = isRecord(parsed.goal)
      ? {
          ...(typeof parsed.goal.title === 'string' ? { title: parsed.goal.title } : {}),
          ...(typeof parsed.goal.line === 'string' ? { line: parsed.goal.line } : {})
        }
      : undefined
    const steps: AntigravitySwarmPlanStep[] | undefined = Array.isArray(parsed.steps)
      ? parsed.steps.flatMap((step): AntigravitySwarmPlanStep[] => {
          if (!isRecord(step) || typeof step.title !== 'string') {
            return []
          }
          return [
            {
              title: step.title,
              ...(typeof step.status === 'string' ? { status: step.status } : {}),
              ...(typeof step.owner === 'string' ? { owner: step.owner } : {}),
              ...(typeof step.detail === 'string' ? { detail: step.detail } : {})
            }
          ]
        })
      : undefined
    return {
      ...(goal ? { goal } : {}),
      ...(steps ? { steps } : {})
    }
  } catch {
    return null
  }
}

function boardTimeMs(value: string): number | null {
  if (!value) {
    return null
  }
  const ms = Date.parse(value.replace(' ', 'T'))
  return Number.isFinite(ms) ? ms : null
}

function mentionsOf(text: string, names: readonly string[]): { mentions: string[]; all: boolean } {
  const all = /(?:^|[^\w@])@all(?![\w-])/i.test(text)
  const found: string[] = []
  for (const name of names) {
    if (!name) {
      continue
    }
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`(?:^|[^\\w@])@${escaped}(?![\\w-])`)
    if (re.test(text)) {
      found.push(name)
    }
  }
  return { mentions: found, all }
}

function resolveMemberStatus(
  member: RawMember,
  transcript: AntigravitySwarmTranscriptSummary | undefined
): AntigravitySwarmMember['status'] {
  if (member.killed === true) {
    return 'killed'
  }
  if (typeof transcript?.idle === 'boolean') {
    return transcript.idle ? 'waiting' : 'working'
  }
  const wakeMode = typeof member.wake_mode === 'string' ? member.wake_mode : ''
  return wakeMode === 'mentions' || wakeMode === 'anything' ? 'waiting' : 'working'
}

function resolveStepFailure(
  transcript: AntigravitySwarmTranscriptSummary | undefined,
  now: number
): AntigravitySwarmMember['failure'] {
  const last = transcript?.last
  if (!last) {
    return null
  }
  const modelError = last.type === 'ERROR_MESSAGE'
  const settledToolError =
    last.status === 'ERROR' && now - (transcript.mtime || 0) >= STEP_ERROR_SETTLE_MS
  if (!modelError && !settledToolError) {
    return null
  }
  const text = last.error || (modelError ? 'Model error' : 'Step failed')
  return { kind: QUOTA_ERROR_RE.test(text) ? 'quota' : 'error', text }
}

function extractWorktreePath(member: RawMember): string | null {
  for (const key of ['worktree', 'worktree_path', 'worktreePath', 'cwd']) {
    const value = member[key]
    if (typeof value === 'string' && value.trim()) {
      return value.trim()
    }
  }
  return null
}

function extractChannels(member: RawMember): string[] {
  if (!Array.isArray(member.channels)) {
    return [MAIN_CHANNEL]
  }
  const valid = member.channels.filter(
    (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0
  )
  return valid.length > 0 ? valid : [MAIN_CHANNEL]
}

export function buildAntigravitySwarmSnapshot(args: {
  swarmId: string
  etag: string
  membersJson: string
  boardJsonl: string
  planJson?: string | null
  transcriptByConversationId?: ReadonlyMap<string, AntigravitySwarmTranscriptSummary>
  now?: number
}): AntigravitySwarmSnapshot | null {
  const roster = parseRawRoster(args.membersJson)
  if (!roster) {
    return null
  }
  const now = args.now ?? Date.now()
  const rawMessages = parseRawBoard(args.boardJsonl)
  const names = Object.keys(roster.members)
  const headSeq = rawMessages.length ? Number(rawMessages.at(-1)?.seq) || rawMessages.length : 0

  const channelSet = new Set<string>([MAIN_CHANNEL])
  const postStats = new Map<
    string,
    { posts: number; lastPostSeq: number; lastPostTime: string; lastPostTs: number | null }
  >()

  const messages: AntigravitySwarmPost[] = rawMessages.map((raw) => {
    const seq = Number(raw.seq) || 0
    const agent = typeof raw.agent === 'string' ? raw.agent : ''
    const text = typeof raw.text === 'string' ? raw.text : ''
    const time = typeof raw.time === 'string' ? raw.time : ''
    const ts = boardTimeMs(time)
    const channel =
      typeof raw.channel === 'string' && raw.channel.trim() && raw.channel !== MAIN_CHANNEL
        ? raw.channel.trim()
        : undefined
    if (channel) {
      channelSet.add(channel)
    }
    const control = isRecord(raw.control) ? raw.control : undefined
    if (control) {
      return {
        seq,
        agent,
        text,
        time,
        ts,
        mentions: [],
        all: false,
        ...(channel ? { channel } : {}),
        control
      }
    }
    const { mentions, all } = mentionsOf(text, names)
    const prev = postStats.get(agent) ?? {
      posts: 0,
      lastPostSeq: 0,
      lastPostTime: '',
      lastPostTs: null
    }
    postStats.set(agent, {
      posts: prev.posts + 1,
      lastPostSeq: seq,
      lastPostTime: time,
      lastPostTs: ts
    })
    return {
      seq,
      agent,
      text,
      time,
      ts,
      mentions,
      all,
      ...(channel ? { channel } : {}),
      ...(typeof raw.kind === 'string' && raw.kind ? { kind: raw.kind } : {}),
      ...(typeof raw.request_id === 'string' && raw.request_id ? { requestId: raw.request_id } : {})
    }
  })

  const members: AntigravitySwarmMember[] = names
    .map((name) => {
      const raw = roster.members[name]!
      const conversationId = typeof raw.conversation_id === 'string' ? raw.conversation_id : ''
      const transcript = conversationId
        ? args.transcriptByConversationId?.get(conversationId)
        : undefined
      const lastReadSeq = Number(raw.last_read_seq) || 0
      const role =
        typeof raw.role === 'string' && raw.role
          ? raw.role
          : name === 'coordinator' || name === 'monitor'
            ? name
            : 'worker'
      const stats = postStats.get(name) ?? {
        posts: 0,
        lastPostSeq: 0,
        lastPostTime: '',
        lastPostTs: null
      }
      return {
        name,
        conversationId,
        model: typeof raw.model === 'string' ? raw.model : '',
        role,
        wakeMode: typeof raw.wake_mode === 'string' ? raw.wake_mode : '',
        status: resolveMemberStatus(raw, transcript),
        waitSince: Number(raw.wait_since) || 0,
        lastReadSeq,
        unread: Math.max(0, headSeq - lastReadSeq),
        killed: raw.killed === true,
        worktree: extractWorktreePath(raw),
        channels: extractChannels(raw),
        steps: transcript?.steps ?? 0,
        activity: transcript?.activity ?? '',
        activityKind: transcript?.activityKind ?? '',
        replied: transcript?.replied ?? false,
        failure: resolveStepFailure(transcript, now),
        ...stats,
        transcriptMtime: transcript?.mtime ?? 0
      }
    })
    .sort((a, b) => {
      const rank = (r: string) => (r === 'coordinator' ? 0 : r === 'monitor' ? 1 : 2)
      return rank(a.role) - rank(b.role) || a.name.localeCompare(b.name)
    })

  return {
    swarmId: args.swarmId,
    title: roster.title || 'Swarm',
    headSeq,
    channels: [...channelSet],
    members,
    messages,
    plan: parseRawPlan(args.planJson),
    etag: args.etag
  }
}
