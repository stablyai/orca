import { describe, expect, it } from 'vitest'
import {
  clearMissingMissionMembers,
  createMission,
  getFolderWorkspaceOwnerEnv,
  getMissionMemberWorktreeIds,
  getMissionRootDirName,
  getMissionWorktreeName,
  getNextMissionTabOrder,
  isMissionEligibleRepo,
  isMissionOwnedFolderWorkspace,
  missionSentinelGroupId,
  normalizeMissionName,
  normalizeMissions,
  slugifyMissionBranch
} from './missions'
import type { Mission } from './types'

function makeMission(overrides: Partial<Mission> & { id: string }): Mission {
  return {
    name: 'Mission',
    branchName: 'mission/mission',
    members: [],
    tabOrder: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides
  }
}

describe('slugifyMissionBranch', () => {
  it('lowercases, dashes spaces, strips unsafe git ref characters', () => {
    expect(slugifyMissionBranch('Referral Flow!')).toBe('mission/referral-flow')
    expect(slugifyMissionBranch('  QA / demo  ')).toBe('mission/qa-demo')
  })

  it('falls back when nothing survives sanitization', () => {
    expect(slugifyMissionBranch('###')).toBe('mission/task')
  })

  it('collapses consecutive dots so the branch stays a valid git ref', () => {
    expect(slugifyMissionBranch('v1..2')).toBe('mission/v1.2')
    expect(slugifyMissionBranch('a...b')).toBe('mission/a.b')
    expect(slugifyMissionBranch('...')).toBe('mission/task')
  })

  it('strips a trailing .lock suffix git refuses in ref components', () => {
    expect(slugifyMissionBranch('deploy.lock')).toBe('mission/deploy')
    expect(slugifyMissionBranch('deploy.lock.lock')).toBe('mission/deploy')
    // Leading-dot trim runs first, and a bare `lock` component is a valid ref.
    expect(slugifyMissionBranch('.lock')).toBe('mission/lock')
    expect(slugifyMissionBranch('lockfile')).toBe('mission/lockfile')
  })
})

describe('getMissionWorktreeName', () => {
  it('flattens the branch path into a filesystem-safe name', () => {
    expect(getMissionWorktreeName('mission/referral-flow')).toBe('mission-referral-flow')
  })
})

describe('normalizeMissionName', () => {
  it('trims and falls back for empty names', () => {
    expect(normalizeMissionName('  qa  ')).toBe('qa')
    expect(normalizeMissionName('   ')).toBe('Untitled mission')
  })
})

describe('createMission', () => {
  it('creates members for unique repo ids and defaults the branch from the name', () => {
    const mission = createMission({
      name: 'Referral',
      repoIds: ['r1', 'r2', 'r1'],
      tabOrder: 3,
      now: 42
    })
    expect(mission.branchName).toBe('mission/referral')
    expect(mission.members.map((m) => m.repoId)).toEqual(['r1', 'r2'])
    expect(mission.members.every((m) => m.worktreeId === null && m.addedAt === 42)).toBe(true)
    expect(mission.tabOrder).toBe(3)
  })

  it('keeps an explicit branch name', () => {
    const mission = createMission({
      name: 'Referral',
      branchName: 'mission/custom',
      repoIds: ['r1'],
      tabOrder: 0
    })
    expect(mission.branchName).toBe('mission/custom')
  })
})

describe('normalizeMissions', () => {
  it('returns [] for non-arrays and drops malformed or duplicate entries', () => {
    expect(normalizeMissions(undefined)).toEqual([])
    expect(normalizeMissions('nope')).toEqual([])
    const valid = makeMission({ id: 'm1' })
    const result = normalizeMissions([valid, { id: 'm1' }, { notAMission: true }, null])
    expect(result.map((m) => m.id)).toEqual(['m1'])
  })

  it('coerces malformed members and sorts by tabOrder then name', () => {
    const result = normalizeMissions([
      makeMission({ id: 'b', name: 'B', tabOrder: 1 }),
      makeMission({ id: 'a', name: 'A', tabOrder: 0, members: [{ repoId: 'r1' }] as never }),
      makeMission({ id: 'c', name: 'C', tabOrder: 0, members: 'junk' as never })
    ])
    expect(result.map((m) => m.id)).toEqual(['a', 'c', 'b'])
    expect(result[0].members).toEqual([
      { repoId: 'r1', worktreeId: null, addedAt: expect.any(Number) }
    ])
    expect(result[1].members).toEqual([])
  })
})

describe('clearMissingMissionMembers', () => {
  it('drops members whose repo no longer exists and reports change', () => {
    const missions = [
      makeMission({
        id: 'm1',
        members: [
          { repoId: 'kept', worktreeId: 'kept::/wt', addedAt: 1 },
          { repoId: 'gone', worktreeId: null, addedAt: 1 }
        ]
      })
    ]
    const result = clearMissingMissionMembers(missions, [{ id: 'kept' }])
    expect(result.changed).toBe(true)
    expect(result.missions[0].members.map((m) => m.repoId)).toEqual(['kept'])
  })

  it('reports no change when all repos exist', () => {
    const missions = [
      makeMission({ id: 'm1', members: [{ repoId: 'kept', worktreeId: null, addedAt: 1 }] })
    ]
    const result = clearMissingMissionMembers(missions, [{ id: 'kept' }])
    expect(result.changed).toBe(false)
    expect(result.missions).toBe(missions as Mission[])
  })
})

describe('getMissionRootDirName', () => {
  it('produces a directory-safe slug with fallback', () => {
    expect(getMissionRootDirName('Referral Flow!')).toBe('referral-flow')
    expect(getMissionRootDirName('###')).toBe('mission')
  })

  it('applies the same dot collapsing as the branch slug', () => {
    expect(getMissionRootDirName('v1..2')).toBe('v1.2')
    expect(getMissionRootDirName('deploy.lock')).toBe('deploy')
  })
})

describe('mission-owned folder workspace helpers', () => {
  it('builds a namespaced sentinel group id and detects ownership', () => {
    expect(missionSentinelGroupId('m1')).toBe('mission:m1')
    expect(isMissionOwnedFolderWorkspace({ missionId: 'm1' })).toBe(true)
    expect(isMissionOwnedFolderWorkspace({ missionId: null })).toBe(false)
    expect(isMissionOwnedFolderWorkspace({})).toBe(false)
  })

  it('maps terminal owner env to the mission id, never the sentinel group id', () => {
    expect(getFolderWorkspaceOwnerEnv({ projectGroupId: 'mission:m1', missionId: 'm1' })).toEqual({
      ORCA_MISSION_ID: 'm1'
    })
    expect(getFolderWorkspaceOwnerEnv({ projectGroupId: 'g1', missionId: null })).toEqual({
      ORCA_PROJECT_GROUP_ID: 'g1'
    })
    expect(getFolderWorkspaceOwnerEnv({ projectGroupId: 'g1' })).toEqual({
      ORCA_PROJECT_GROUP_ID: 'g1'
    })
  })
})

describe('normalizeMissions rootPath', () => {
  it('round-trips a string rootPath and nulls junk', () => {
    const withRoot = normalizeMissions([makeMission({ id: 'a', rootPath: '/x/missions/a' })])
    expect(withRoot[0].rootPath).toBe('/x/missions/a')
    const withJunk = normalizeMissions([makeMission({ id: 'b', rootPath: 42 as never })])
    expect(withJunk[0].rootPath).toBeNull()
  })
})

describe('isMissionEligibleRepo', () => {
  it('accepts local and ssh repos, rejects runtime-owned repos', () => {
    expect(isMissionEligibleRepo({})).toBe(true)
    expect(isMissionEligibleRepo({ executionHostId: null })).toBe(true)
    expect(isMissionEligibleRepo({ executionHostId: 'local' })).toBe(true)
    expect(isMissionEligibleRepo({ executionHostId: 'ssh:target-1' })).toBe(true)
    expect(isMissionEligibleRepo({ executionHostId: 'runtime:env-1' })).toBe(false)
  })
})

describe('getMissionMemberWorktreeIds', () => {
  it('collects only assigned worktree ids across missions', () => {
    const ids = getMissionMemberWorktreeIds([
      makeMission({
        id: 'a',
        members: [
          { repoId: 'r1', worktreeId: 'r1::/wt/a', addedAt: 1 },
          { repoId: 'r2', worktreeId: null, addedAt: 1 }
        ]
      }),
      makeMission({ id: 'b', members: [{ repoId: 'r3', worktreeId: 'r3::/wt/b', addedAt: 1 }] })
    ])
    expect([...ids].sort()).toEqual(['r1::/wt/a', 'r3::/wt/b'])
  })
})

describe('getNextMissionTabOrder', () => {
  it('returns max + 1 and 0 for empty lists', () => {
    expect(getNextMissionTabOrder([])).toBe(0)
    expect(getNextMissionTabOrder([makeMission({ id: 'a', tabOrder: 4 })])).toBe(5)
  })
})
