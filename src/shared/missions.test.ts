import { describe, expect, it } from 'vitest'
import {
  clearMissingMissionMembers,
  createMission,
  getMissionWorktreeName,
  getNextMissionTabOrder,
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

describe('getNextMissionTabOrder', () => {
  it('returns max + 1 and 0 for empty lists', () => {
    expect(getNextMissionTabOrder([])).toBe(0)
    expect(getNextMissionTabOrder([makeMission({ id: 'a', tabOrder: 4 })])).toBe(5)
  })
})
