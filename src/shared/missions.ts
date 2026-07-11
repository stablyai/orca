import type { Mission, MissionMember } from './types'

function createMissionInstanceId(): string {
  const randomUUID = globalThis.crypto?.randomUUID
  if (randomUUID) {
    return randomUUID.call(globalThis.crypto)
  }
  return `mission-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function normalizeMissionName(name: string, fallback = 'Untitled mission'): string {
  const trimmed = name.trim()
  return trimmed.length > 0 ? trimmed : fallback
}

/** Branch shared by every member worktree. Restricted to a conservative
 *  charset so the result is a valid git ref on every host. */
export function slugifyMissionBranch(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
  return `mission/${slug || 'task'}`
}

export function getMissionWorktreeName(branchName: string): string {
  return branchName.replace(/[\\/]+/g, '-')
}

function normalizeMissionBranchName(branchName: string | null | undefined, name: string): string {
  const trimmed = branchName?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : slugifyMissionBranch(name)
}

export function createMission(input: {
  name: string
  branchName?: string | null
  repoIds: readonly string[]
  tabOrder: number
  now?: number
}): Mission {
  const now = input.now ?? Date.now()
  const name = normalizeMissionName(input.name)
  const members: MissionMember[] = []
  const seen = new Set<string>()
  for (const repoId of input.repoIds) {
    if (!repoId || seen.has(repoId)) {
      continue
    }
    seen.add(repoId)
    members.push({ repoId, worktreeId: null, addedAt: now })
  }
  return {
    id: createMissionInstanceId(),
    name,
    branchName: normalizeMissionBranchName(input.branchName, name),
    members,
    tabOrder: input.tabOrder,
    createdAt: now,
    updatedAt: now
  }
}

function normalizeMissionMembers(value: unknown, now: number): MissionMember[] {
  if (!Array.isArray(value)) {
    return []
  }
  const members: MissionMember[] = []
  const seen = new Set<string>()
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') {
      continue
    }
    const raw = candidate as Partial<MissionMember>
    if (typeof raw.repoId !== 'string' || raw.repoId.length === 0 || seen.has(raw.repoId)) {
      continue
    }
    seen.add(raw.repoId)
    members.push({
      repoId: raw.repoId,
      worktreeId: typeof raw.worktreeId === 'string' ? raw.worktreeId : null,
      addedAt: typeof raw.addedAt === 'number' && Number.isFinite(raw.addedAt) ? raw.addedAt : now
    })
  }
  return members
}

export function normalizeMissions(value: unknown): Mission[] {
  if (!Array.isArray(value)) {
    return []
  }
  const missions: Mission[] = []
  const seen = new Set<string>()
  for (const candidate of value) {
    if (!candidate || typeof candidate !== 'object') {
      continue
    }
    const raw = candidate as Partial<Mission>
    if (typeof raw.id !== 'string' || raw.id.length === 0 || seen.has(raw.id)) {
      continue
    }
    seen.add(raw.id)
    const now = Date.now()
    const name = normalizeMissionName(typeof raw.name === 'string' ? raw.name : '')
    missions.push({
      id: raw.id,
      name,
      branchName:
        typeof raw.branchName === 'string' && raw.branchName.trim().length > 0
          ? raw.branchName
          : slugifyMissionBranch(name),
      members: normalizeMissionMembers(raw.members, now),
      tabOrder:
        typeof raw.tabOrder === 'number' && Number.isFinite(raw.tabOrder) ? raw.tabOrder : 0,
      createdAt:
        typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : now,
      updatedAt:
        typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : now
    })
  }
  missions.sort(
    (left, right) => left.tabOrder - right.tabOrder || left.name.localeCompare(right.name)
  )
  return missions
}

/** Hydrate-time sanitization: drop members whose repo was removed from Orca.
 *  Dangling worktreeIds are intentionally kept — the renderer resolves them
 *  against live worktrees and degrades to a "recreate" row. */
export function clearMissingMissionMembers(
  missions: readonly Mission[],
  repos: readonly { id: string }[]
): { missions: Mission[]; changed: boolean } {
  const repoIds = new Set(repos.map((repo) => repo.id))
  let changed = false
  const next = missions.map((mission) => {
    const members = mission.members.filter((member) => repoIds.has(member.repoId))
    if (members.length === mission.members.length) {
      return mission
    }
    changed = true
    return { ...mission, members }
  })
  return { missions: changed ? next : (missions as Mission[]), changed }
}

export function getNextMissionTabOrder(missions: readonly Mission[]): number {
  let max = -1
  for (const mission of missions) {
    if (Number.isFinite(mission.tabOrder)) {
      max = Math.max(max, mission.tabOrder)
    }
  }
  return max + 1
}
