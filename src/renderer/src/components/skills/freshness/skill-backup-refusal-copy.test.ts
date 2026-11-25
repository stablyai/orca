import { describe, expect, it } from 'vitest'
import type { BundledSkillRefusalNotice } from '../../../../../shared/skills/bundled/bundled-skill-backup-refusal'
import { skillRefusalLines } from './skill-backup-refusal-copy'

const SKILLS = '/home/u/.agents/skills'
const notice = (fields: Partial<BundledSkillRefusalNotice>): BundledSkillRefusalNotice => ({
  skill: 'orca',
  path: `${SKILLS}/orca`,
  source: 'in-place',
  contentApplied: false,
  offeredAgain: true,
  ...fields
})

describe('cross-drive backup refusal lines', () => {
  it('a Replace kept in place asks the user to move it, then try again', () => {
    expect(skillRefusalLines(notice({}))).toEqual({
      reason: "Can't back it up: it's on another drive.",
      path: `${SKILLS}/orca`,
      next: 'Move it out of the skills folder, then try again.'
    })
  })

  it('a retired copy put back in place never promises a retry will find it', () => {
    const former = '/home/u/.gemini/skills/orca'
    expect(skillRefusalLines(notice({ path: former, offeredAgain: false }))).toEqual({
      reason: "Can't back it up: it's on another drive.",
      path: former,
      next: "Move it out of the skills folder. Orca won't remind you."
    })
  })

  it('a left-over copy is named as one', () => {
    const leftover = `${SKILLS}/.orca.orca-old-1`
    expect(skillRefusalLines(notice({ path: leftover, source: 'leftover' }))).toEqual({
      reason: "Can't back up the left-over copy: it's on another drive.",
      path: leftover,
      next: 'Move it out of the skills folder, then try again.'
    })
  })

  it('an old copy moved aside says how to keep it, and whether Orca will mention it again', () => {
    const aside = `${SKILLS}/.orca.orca-old-2`
    expect(skillRefusalLines(notice({ path: aside, source: 'moved-aside' }))).toEqual({
      reason: "Couldn't back up the old copy: it's on another drive.",
      path: aside,
      next: 'Move it out of the skills folder to keep it.'
    })
    expect(
      skillRefusalLines(notice({ path: aside, source: 'moved-aside', offeredAgain: false })).next
    ).toBe("Move it out of the skills folder. Orca won't remind you.")
  })
})
