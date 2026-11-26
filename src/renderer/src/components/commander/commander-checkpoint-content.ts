import type { DashboardCard } from '../../../../shared/agent-status/presentation/dashboard-snapshot'
import {
  getRepoRegistrationHostIds,
  type RepoHostTarget
} from '../../../../shared/repository/repo-host-identity'

type ProgressCard = Pick<
  DashboardCard,
  'dotState' | 'agentType' | 'worktreeName' | 'task' | 'askSummary'
>

function inline(value: string, limit: number): string {
  return value.replace(/\s+/gu, ' ').trim().slice(0, limit)
}

export function checkpointMarkdown(cards: readonly ProgressCard[]): string {
  const states = ['blocked', 'waiting', 'working', 'done', 'idle'] as const
  const groups = new Map<ProgressCard['dotState'], string[]>(states.map((state) => [state, []]))
  for (const card of cards) {
    const task = inline(card.askSummary || card.task, 140)
    const workspace = inline(card.worktreeName, 60)
    const agent = inline(card.agentType, 40)
    groups.get(card.dotState)?.push(`- ${workspace} · ${agent}${task ? ` — ${task}` : ''}`)
  }
  const sections = states.flatMap((state) => {
    const rows = groups.get(state) ?? []
    if (!rows.length) {
      return []
    }
    rows.sort()
    return [
      `## ${state} (${rows.length})`,
      ...rows.slice(0, 16),
      ...(rows.length > 16 ? [`… ${rows.length - 16} more`] : []),
      ''
    ]
  })
  return sections.join('\n').trim()
}

/** Stored in generated checkpoints so a restart cannot erase an unobserved host. */
export type CheckpointSource = { hostId: string; repoId: string; worktreeId?: string }

function possibleSourceHosts(source: CheckpointSource, repos: readonly RepoHostTarget[]): string[] {
  if (source.hostId) {
    return [source.hostId]
  }
  // Older cards defaulted to local but could lack their same-ID remote registration's host.
  const hosts = getRepoRegistrationHostIds(repos, source.repoId)
  hosts.add('local')
  return [...hosts]
}

export function checkpointCardSource(
  card: Pick<DashboardCard, 'executionHostId' | 'repoId' | 'worktreeId'>,
  repos: readonly RepoHostTarget[]
): CheckpointSource {
  const source = {
    hostId: card.executionHostId ?? '',
    repoId: card.repoId,
    worktreeId: card.worktreeId
  }
  if (!source.hostId && possibleSourceHosts(source, repos).length === 1) {
    return { ...source, hostId: 'local' }
  }
  return source
}

export function qualifyCheckpointSources(
  sources: readonly CheckpointSource[],
  repos: readonly RepoHostTarget[]
): CheckpointSource[] {
  return sources.flatMap((source) =>
    possibleSourceHosts(source, repos).map((hostId) => ({ ...source, hostId }))
  )
}

const sourcePrefix = 'Observed registrations: '

export function checkpointSources(body: string): CheckpointSource[] {
  const line = body.split('\n').at(-1) ?? ''
  if (!line.startsWith(sourcePrefix)) {
    return []
  }
  try {
    const parsed: unknown = JSON.parse(line.slice(sourcePrefix.length))
    if (
      !Array.isArray(parsed) ||
      !parsed.every(
        (row) =>
          row &&
          typeof row.hostId === 'string' &&
          typeof row.repoId === 'string' &&
          (row.worktreeId === undefined || typeof row.worktreeId === 'string')
      )
    ) {
      return []
    }
    return parsed
  } catch {
    return []
  }
}

export function checkpointObservation(
  summary: string,
  sources: readonly CheckpointSource[]
): string {
  const rows = [
    ...new Map(sources.map((source) => [JSON.stringify(source), source])).values()
  ].sort(
    (a, b) =>
      a.hostId.localeCompare(b.hostId) ||
      a.repoId.localeCompare(b.repoId) ||
      (a.worktreeId ?? '').localeCompare(b.worktreeId ?? '')
  )
  return [
    'Last observed agent activity',
    summary || 'No agents reported in the verified project workspaces.',
    sourcePrefix + JSON.stringify(rows)
  ].join('\n\n')
}

export function missingCheckpointSources(
  previousBody: string,
  current: readonly CheckpointSource[],
  repos: readonly RepoHostTarget[]
): CheckpointSource[] {
  const previous = checkpointSources(previousBody)
  const verifiedEmpty = previousBody === checkpointObservation('', previous)
  return qualifyCheckpointSources(previous, repos).filter(
    (old) =>
      !current.some(
        (row) =>
          row.hostId === old.hostId &&
          row.repoId === old.repoId &&
          (old.worktreeId === undefined ? verifiedEmpty : row.worktreeId === old.worktreeId)
      )
  )
}

type ListingEvidence = {
  truncated?: boolean
  hostScope?: { hostIds: string[]; omittedHostIds: string[] }
  worktrees: {
    hostId?: string
    repoId: string
    worktreeId?: string
    agents: unknown[]
    unverifiableTerminalCount?: number
    liveTerminalCount: number
  }[]
}

export function confirmsNoAgents(
  listing: ListingEvidence,
  repoId: string,
  hostId: string,
  worktreeId?: string
): boolean {
  if (
    listing.truncated !== false ||
    !listing.hostScope?.hostIds.includes(hostId) ||
    listing.hostScope.omittedHostIds.includes(hostId)
  ) {
    return false
  }
  const rows = listing.worktrees.filter(
    (row) =>
      row.repoId === repoId &&
      row.hostId === hostId &&
      (worktreeId === undefined || row.worktreeId === worktreeId)
  )
  return (
    rows.length > 0 &&
    rows.every(
      (row) =>
        row.unverifiableTerminalCount === 0 &&
        row.liveTerminalCount === 0 &&
        row.agents.length === 0
    )
  )
}
