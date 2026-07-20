import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from './execution-host'
import { isFolderRepo } from './repo-kind'
import { isTuiAgent } from './tui-agent-config'
import type { Mission, MissionMember, Repo } from './types'
import { isWslUncPath } from './wsl-paths'

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

/** Shared slug chain for the mission branch and root directory. Restricted to
 *  a conservative charset; `..` runs and trailing `.lock` are stripped because
 *  git check-ref-format rejects both anywhere in a ref component. */
function slugifyMissionText(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[-._]+|[-._]+$/g, '')
    .replace(/(?:\.lock)+$/, '')
    .replace(/[-._]+$/g, '')
}

function hashMissionText(value: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function hasNonAsciiMissionText(value: string): boolean {
  for (const character of value) {
    if ((character.codePointAt(0) ?? 0) > 0x7f) {
      return true
    }
  }
  return false
}

/** Branch shared by every member worktree. The optional mission identity keeps
 *  names with no ASCII slug (for example Korean) from all collapsing to task. */
export function slugifyMissionBranch(name: string, missionId?: string): string {
  const slug = slugifyMissionText(name)
  const identity = hasNonAsciiMissionText(name)
    ? hashMissionText(name.trim())
    : slugifyMissionText(missionId ?? '')
        .replace(/^mission-/, '')
        .slice(0, 8)
  return `mission/${slug || (identity ? `task-${identity}` : 'task')}`
}

export function getMissionWorktreeName(branchName: string): string {
  return branchName.replace(/[\\/]+/g, '-')
}

/** Directory-safe name for the mission root (and its member links). */
export function getMissionRootDirName(name: string): string {
  return slugifyMissionText(name) || 'mission'
}

/** Sentinel projectGroupId carried by mission session folder workspaces.
 *  Namespaced so it can never collide with a real project-group id. */
export function missionSentinelGroupId(missionId: string): string {
  return `mission:${missionId}`
}

export function isMissionOwnedFolderWorkspace(workspace: { missionId?: string | null }): boolean {
  return typeof workspace.missionId === 'string' && workspace.missionId.length > 0
}

/** Terminal env identity for a folder workspace's owner. Mission sessions
 *  expose ORCA_MISSION_ID — never the sentinel projectGroupId, which no real
 *  group owns and would confuse scripts keying on ORCA_PROJECT_GROUP_ID. */
export function getFolderWorkspaceOwnerEnv(workspace: {
  projectGroupId: string
  missionId?: string | null
}): Record<string, string> {
  if (isMissionOwnedFolderWorkspace(workspace)) {
    return { ORCA_MISSION_ID: workspace.missionId! }
  }
  return { ORCA_PROJECT_GROUP_ID: workspace.projectGroupId }
}

function normalizeMissionBranchName(
  branchName: string | null | undefined,
  name: string,
  missionId: string
): string {
  const trimmed = branchName?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : slugifyMissionBranch(name, missionId)
}

export function createMission(input: {
  name: string
  branchName?: string | null
  repoIds: readonly string[]
  tabOrder: number
  sessionAgent?: Mission['sessionAgent']
  now?: number
}): Mission {
  const now = input.now ?? Date.now()
  const name = normalizeMissionName(input.name)
  const id = createMissionInstanceId()
  const members: MissionMember[] = []
  const seen = new Set<string>()
  for (const repoId of input.repoIds) {
    if (!repoId || seen.has(repoId)) {
      continue
    }
    seen.add(repoId)
    members.push({
      repoId,
      worktreeId: null,
      worktreeInstanceId: null,
      lastError: null,
      addedAt: now
    })
  }
  return {
    id,
    name,
    branchName: normalizeMissionBranchName(input.branchName, name, id),
    members,
    tabOrder: input.tabOrder,
    ...(input.sessionAgent ? { sessionAgent: input.sessionAgent } : {}),
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
    const worktreeId =
      typeof raw.worktreeId === 'string' && raw.worktreeId.length > 0 ? raw.worktreeId : null
    members.push({
      repoId: raw.repoId,
      worktreeId,
      // Why: an instance stamp without its path-derived worktree id cannot
      // safely identify ownership and must not be adopted during hydration.
      worktreeInstanceId:
        worktreeId &&
        typeof raw.worktreeInstanceId === 'string' &&
        raw.worktreeInstanceId.length > 0
          ? raw.worktreeInstanceId
          : null,
      lastError:
        typeof raw.lastError === 'string' && raw.lastError.trim().length > 0
          ? raw.lastError.trim()
          : null,
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
          : slugifyMissionBranch(name, raw.id),
      members: normalizeMissionMembers(raw.members, now),
      tabOrder:
        typeof raw.tabOrder === 'number' && Number.isFinite(raw.tabOrder) ? raw.tabOrder : 0,
      rootPath: typeof raw.rootPath === 'string' && raw.rootPath.length > 0 ? raw.rootPath : null,
      rootBasePath:
        typeof raw.rootPath === 'string' &&
        raw.rootPath.length > 0 &&
        typeof raw.rootBasePath === 'string' &&
        raw.rootBasePath.length > 0
          ? raw.rootBasePath
          : null,
      ...(isTuiAgent(raw.sessionAgent) ? { sessionAgent: raw.sessionAgent } : {}),
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

/** Mission V1 roots and sessions run on Orca's native local host. Remote,
 *  runtime-owned, and WSL-backed repos cannot share that filesystem root. */
export function isMissionEligibleRepo(
  repo: Pick<Repo, 'path' | 'kind' | 'connectionId' | 'executionHostId'>
): boolean {
  // Why: legacy SSH repos may only carry connectionId, while newer records
  // carry executionHostId; either signal must keep them out of local Missions.
  return (
    !isFolderRepo(repo) &&
    !repo.connectionId &&
    getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID &&
    !isWslUncPath(repo.path)
  )
}

/** Worktree ids owned by mission members. The Projects view hides these —
 *  mission work belongs to the Missions tab; only the mission views (and the
 *  workspace itself) surface them. */
export function getMissionMemberWorktreeIds(missions: readonly Mission[]): Set<string> {
  const ids = new Set<string>()
  for (const mission of missions) {
    for (const member of mission.members) {
      if (member.worktreeId) {
        ids.add(member.worktreeId)
      }
    }
  }
  return ids
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
