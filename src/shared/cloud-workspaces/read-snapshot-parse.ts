// Lenient parser for the read snapshot payload a sleeping workspace's VM wrote (see read-snapshot.ts
// for the sealed construction). Free of node:crypto and Buffer, like the opener.
import type {
  ReadSnapshot,
  ReadSnapshotAgentStatus,
  ReadSnapshotChange,
  ReadSnapshotGit,
  ReadSnapshotMessage,
  ReadSnapshotPr,
  ReadSnapshotRole,
  ReadSnapshotSession
} from './read-snapshot'

/** Plaintext bounds the VM keeps to (the opener re-checks them; anything over is cut, not trusted). */
export const READ_SNAPSHOT_LIMITS = {
  sessions: 12,
  messagesPerSession: 60,
  messageChars: 4000,
  changes: 200,
  commits: 10,
  titleChars: 200
} as const

// The payload came from the VM: parse leniently field by field, cut to the limits, never trust it.
type Obj = Record<string, unknown>
const isObj = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const str = (value: unknown, max: number): string | null =>
  typeof value === 'string' ? value.slice(0, max) : null
const num = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

const ROLES: ReadonlySet<string> = new Set<ReadSnapshotRole>(['user', 'assistant', 'system'])
const STATUSES: ReadonlySet<string> = new Set<ReadSnapshotAgentStatus>([
  'working',
  'attention',
  'idle'
])
const isRole = (value: unknown): value is ReadSnapshotRole =>
  typeof value === 'string' && ROLES.has(value)
const isStatus = (value: unknown): value is ReadSnapshotAgentStatus =>
  typeof value === 'string' && STATUSES.has(value)

function messageOf(value: unknown): ReadSnapshotMessage | null {
  if (!isObj(value) || !isRole(value.role)) {
    return null
  }
  const text = str(value.text, READ_SNAPSHOT_LIMITS.messageChars)
  const itemId = str(value.itemId, 200)
  if (!text || !itemId) {
    return null
  }
  return { itemId, role: value.role, text, at: num(value.at) ?? 0 }
}

function sessionOf(value: unknown): ReadSnapshotSession | null {
  if (!isObj(value)) {
    return null
  }
  const sessionId = str(value.sessionId, 200)
  if (!sessionId) {
    return null
  }
  const all = arr(value.messages)
    .map(messageOf)
    .filter((m): m is ReadSnapshotMessage => m !== null)
  const messages = all.slice(-READ_SNAPSHOT_LIMITS.messagesPerSession)
  const status: ReadSnapshotAgentStatus = isStatus(value.status) ? value.status : 'unknown'

  return {
    sessionId,
    agent: str(value.agent, 40),
    title: str(value.title, READ_SNAPSHOT_LIMITS.titleChars),
    status,
    turnOutcome: str(value.turnOutcome, 40),
    updatedAt: num(value.updatedAt),
    messages,
    truncated: value.truncated === true || messages.length < all.length
  }
}

function gitOf(value: unknown): ReadSnapshotGit | null {
  if (!isObj(value)) {
    return null
  }
  const changes = arr(value.changes)
    .flatMap((raw): ReadSnapshotChange[] => {
      if (!isObj(raw)) {
        return []
      }
      const path = str(raw.path, 1024)
      return path
        ? [
            {
              path,
              status: str(raw.status, 20) ?? 'modified',
              area: str(raw.area, 20) ?? 'unstaged',
              added: num(raw.added),
              removed: num(raw.removed)
            }
          ]
        : []
    })
    .slice(0, READ_SNAPSHOT_LIMITS.changes)
  const commits = arr(value.commits)
    .flatMap((raw) => {
      if (!isObj(raw)) {
        return []
      }
      const id = str(raw.id, 64)
      const subject = str(raw.subject, 300)
      return id && subject !== null
        ? [{ id, subject, author: str(raw.author, 120), at: num(raw.at) }]
        : []
    })
    .slice(0, READ_SNAPSHOT_LIMITS.commits)
  return {
    branch: str(value.branch, 255),
    head: str(value.head, 64),
    changes,
    changeCount: Math.max(num(value.changeCount) ?? changes.length, changes.length),
    added: num(value.added),
    removed: num(value.removed),
    commits
  }
}

function prOf(value: unknown): ReadSnapshotPr | null {
  if (!isObj(value)) {
    return null
  }
  const number = num(value.number)
  const url = str(value.url, 500)
  // Only links a person can safely tap.
  if (number === null || !url || !url.startsWith('https://')) {
    return null
  }
  return {
    number,
    title: str(value.title, 300) ?? '',
    state: str(value.state, 20) ?? 'open',
    url,
    checksStatus: str(value.checksStatus, 20),
    checksSummary: str(value.checksSummary, 200)
  }
}

export function parseReadSnapshot(value: unknown): ReadSnapshot | null {
  if (!isObj(value) || value.v !== 1) {
    return null
  }
  const workspaceId = str(value.workspaceId, 64)
  const snapshotId = str(value.snapshotId, 64)
  const capturedAt = num(value.capturedAt)
  if (!workspaceId || !snapshotId || capturedAt === null) {
    return null
  }
  return {
    v: 1,
    workspaceId,
    snapshotId,
    capturedAt,
    reason: str(value.reason, 20) ?? 'sleep',
    git: gitOf(value.git),
    pr: prOf(value.pr),
    sessions: arr(value.sessions)
      .map(sessionOf)
      .filter((s): s is ReadSnapshotSession => s !== null)
      .slice(0, READ_SNAPSHOT_LIMITS.sessions)
  }
}
