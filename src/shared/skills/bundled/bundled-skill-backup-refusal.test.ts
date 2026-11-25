import { describe, expect, it } from 'vitest'
import {
  bundledSkillOpBackupPaths,
  bundledSkillOpRefusalNotice,
  bundledSkillRefusalNotices
} from './bundled-skill-backup-refusal'
import type { BundledSkillOpOutcome } from './bundled-skill-plan'

const SKILLS = '/home/u/.agents/skills'
const op = (fields: Partial<BundledSkillOpOutcome>): BundledSkillOpOutcome => ({
  path: `${SKILLS}/orca`,
  kind: 'update',
  status: 'failed',
  error: 'EXDEV',
  ...fields
})

describe('bundled skill backup refusal notices', () => {
  it('offers a moved-aside copy again unless the host marks this result its only notice', () => {
    const beside = bundledSkillOpRefusalNotice(
      'orca',
      op({
        contentApplied: true,
        backupRefusal: { path: `${SKILLS}/.orca.orca-old-1`, source: 'moved-aside' }
      })
    )
    expect(beside).toEqual({
      skill: 'orca',
      path: `${SKILLS}/.orca.orca-old-1`,
      source: 'moved-aside',
      contentApplied: true,
      offeredAgain: true
    })
    const formerRoot = bundledSkillOpRefusalNotice(
      'orca',
      op({
        contentApplied: true,
        backupRefusal: {
          path: '/home/u/.gemini/skills/.orca.orca-old-2',
          source: 'moved-aside',
          onlyNotice: true
        }
      })
    )
    expect(formerRoot?.offeredAgain).toBe(false)
  })

  it('never infers a refusal from a generic EXDEV', () => {
    expect(bundledSkillOpRefusalNotice('orca', op({}))).toBeNull()
    expect(
      bundledSkillRefusalNotices({
        scope: 'global',
        skills: [{ name: 'orca', status: 'ran', ops: [op({})] }]
      })
    ).toEqual([])
  })

  it('lists every backup, falling back to an older host’s single path', () => {
    expect(
      bundledSkillOpBackupPaths(op({ backupPath: '/b/1', backupPaths: ['/b/1', '/b/2'] }))
    ).toEqual(['/b/1', '/b/2'])
    expect(bundledSkillOpBackupPaths(op({ backupPath: '/b/1' }))).toEqual(['/b/1'])
    expect(bundledSkillOpBackupPaths(op({}))).toEqual([])
  })
})
