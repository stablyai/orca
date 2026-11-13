import type { CommunityActivity } from '../../../../shared/community-operations'

export type CommunityGroupMode = 'affiliation' | 'roles'
export type CommunityAuthorGroup = 'community' | 'team' | 'automation' | 'unknown'
export const COMMUNITY_GROUPS = ['community', 'team', 'automation', 'unknown'] as const
export const COMMUNITY_GROUP_COLORS = {
  community: 'var(--chart-2)',
  team: 'var(--chart-4)',
  automation: 'var(--chart-1)',
  unknown: 'var(--muted-foreground)'
}
type ActivityRow = CommunityActivity['rows'][number]

export function communityAuthorGroup(
  row: ActivityRow,
  data: CommunityActivity,
  mode: CommunityGroupMode
): CommunityAuthorGroup {
  if (row.authorType === 'Bot' || row.author.endsWith('[bot]')) {
    return 'automation'
  }
  if (row.author === 'Deleted account') {
    return 'unknown'
  }
  if (mode === 'roles') {
    if (!data.maintainers) {
      return 'unknown'
    }
    return data.maintainers.some((name) => name.toLowerCase() === row.author.toLowerCase())
      ? 'team'
      : 'community'
  }
  if (['OWNER', 'MEMBER', 'COLLABORATOR'].includes(row.authorAssociation)) {
    return 'team'
  }
  return ['CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', 'FIRST_TIMER', 'NONE'].includes(
    row.authorAssociation
  )
    ? 'community'
    : 'unknown'
}

export function communityActivityGroups(data: CommunityActivity, mode: CommunityGroupMode) {
  return COMMUNITY_GROUPS.map((id) => ({
    id,
    color: COMMUNITY_GROUP_COLORS[id],
    rows: data.rows.filter((row) => communityAuthorGroup(row, data, mode) === id)
  }))
}

export function communityActivityWeeks(data: CommunityActivity, mode: CommunityGroupMode) {
  const start = new Date(data.complete ? data.since : data.cutoff)
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7))
  const end = new Date(data.capturedAt)
  const weeks: {
    date: string
    groups: { id: CommunityAuthorGroup; count: number; known: number; approved: number }[]
  }[] = []
  while (start <= end) {
    const next = new Date(start)
    next.setDate(next.getDate() + 7)
    const rows = data.rows.filter((row) => {
      const at = new Date(row.createdAt).getTime()
      return at >= start.getTime() && at < next.getTime()
    })
    weeks.push({
      date: start.toISOString(),
      groups: COMMUNITY_GROUPS.map((id) => {
        const group = rows.filter((row) => communityAuthorGroup(row, data, mode) === id)
        const field = mode === 'roles' ? 'maintainerApproved' : 'memberApproved'
        const observed = group.filter((row) => row[field] !== null)
        return {
          id,
          count: group.length,
          known: observed.length,
          approved: observed.filter((row) => row[field]).length
        }
      })
    })
    start.setTime(next.getTime())
  }
  return weeks
}

export function communityOutcomeCounts(rows: ActivityRow[]): [number, number, number] {
  return [
    rows.filter((row) => row.merged).length,
    rows.filter((row) => !row.closed && !row.merged).length,
    rows.filter((row) => row.closed && !row.merged).length
  ]
}
