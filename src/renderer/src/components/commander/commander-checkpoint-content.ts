import type { DashboardCard } from '../../../../shared/agent-status/presentation/dashboard-snapshot'

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
  const rows = listing.worktrees.filter((row) => row.repoId === repoId && row.hostId === hostId)
  return (
    rows.length > 0 &&
    (!worktreeId || rows.some((row) => row.worktreeId === worktreeId)) &&
    rows.every(
      (row) =>
        row.unverifiableTerminalCount === 0 &&
        row.liveTerminalCount === 0 &&
        row.agents.length === 0
    )
  )
}
