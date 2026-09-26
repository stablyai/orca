import type {
  CcSyncItem,
  CcSyncPause
} from '../../../../shared/cross-machine-recovery-provider-types'

export type RecoverySessionRow = {
  sessionId: string
  title: string
  lastActivityAt: number | null
  lastHumanActivityAt: number | null
  activity: CcSyncItem['sessions'][number]['activity']
  liveLocalCollision: boolean
}

export type RecoveryWorkspaceRow = {
  selector: string
  workspaceName: string
  repoName: string
  branch: string | null
  checkpointCapturedAt: number | null
  completeness: CcSyncItem['completeness']
  pause: CcSyncPause | null
  sessions: RecoverySessionRow[]
  newestHumanActivityAt: number | null
  defaultResumeSessionId: string | null
}

export type RecoverySourceGroup = {
  hostId: string
  hostName: string
  reachable: boolean
  lastSeenAt: number | null
  newestHumanActivityAt: number | null
  workspaces: RecoveryWorkspaceRow[]
}

function parseTimestamp(value: string | null): number | null {
  if (value === null) {
    return null
  }
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

function newestFirst(a: number | null, b: number | null): number {
  return (b ?? Number.NEGATIVE_INFINITY) - (a ?? Number.NEGATIVE_INFINITY)
}

function maxTimestamp(values: (number | null)[]): number | null {
  return values.reduce<number | null>(
    (max, value) => (value !== null && (max === null || value > max) ? value : max),
    null
  )
}

/** The session the user most recently typed into; every other session imports dormant. */
export function defaultResumeSessionId(sessions: readonly RecoverySessionRow[]): string | null {
  const candidates = sessions.filter(
    (session) => !session.liveLocalCollision && session.lastHumanActivityAt !== null
  )
  return (
    candidates.sort((a, b) => newestFirst(a.lastHumanActivityAt, b.lastHumanActivityAt))[0]
      ?.sessionId ?? null
  )
}

function toWorkspaceRow(item: CcSyncItem): RecoveryWorkspaceRow {
  const sessions = item.sessions
    .map((session): RecoverySessionRow => ({
      sessionId: session.session_id,
      title: session.title,
      lastActivityAt: parseTimestamp(session.last_activity_at),
      lastHumanActivityAt: parseTimestamp(session.last_human_activity_at),
      activity: session.activity,
      liveLocalCollision: session.live_local_collision
    }))
    .sort(
      (a, b) =>
        newestFirst(a.lastHumanActivityAt, b.lastHumanActivityAt) ||
        newestFirst(a.lastActivityAt, b.lastActivityAt)
    )
  return {
    selector: item.selector,
    workspaceName: item.workspace.orca?.name ?? item.workspace.repo_name,
    repoName: item.workspace.repo_name,
    branch: item.workspace.branch,
    checkpointCapturedAt: parseTimestamp(item.checkpoint.captured_at),
    completeness: item.completeness,
    pause: item.pause,
    sessions,
    newestHumanActivityAt: maxTimestamp(sessions.map((session) => session.lastHumanActivityAt)),
    defaultResumeSessionId: defaultResumeSessionId(sessions)
  }
}

/** Groups items source → workspace → sessions: unreachable sources first, then newest human use. */
export function buildRecoverySourceGroups(items: readonly CcSyncItem[]): RecoverySourceGroup[] {
  const groups = new Map<string, RecoverySourceGroup>()
  for (const item of items) {
    const group = groups.get(item.source.host_id) ?? {
      hostId: item.source.host_id,
      hostName: item.source.host_name,
      reachable: item.source.reachable,
      lastSeenAt: parseTimestamp(item.source.last_seen_at),
      newestHumanActivityAt: null,
      workspaces: []
    }
    group.workspaces.push(toWorkspaceRow(item))
    groups.set(item.source.host_id, group)
  }
  const sorted = [...groups.values()].map((group) => {
    const workspaces = group.workspaces.sort((a, b) =>
      newestFirst(a.newestHumanActivityAt, b.newestHumanActivityAt)
    )
    return {
      ...group,
      workspaces,
      newestHumanActivityAt: maxTimestamp(workspaces.map((row) => row.newestHumanActivityAt))
    }
  })
  return sorted.sort(
    (a, b) =>
      Number(a.reachable) - Number(b.reachable) ||
      newestFirst(a.newestHumanActivityAt, b.newestHumanActivityAt)
  )
}

export type RecoveryWorkspaceDisabledReason = { kind: 'not-ready'; missing: string[] } | null

export function workspaceDisabledReason(
  row: RecoveryWorkspaceRow
): RecoveryWorkspaceDisabledReason {
  return row.completeness.ready ? null : { kind: 'not-ready', missing: row.completeness.missing }
}
