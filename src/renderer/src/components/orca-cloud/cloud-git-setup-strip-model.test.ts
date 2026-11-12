import { describe, expect, it } from 'vitest'
import { translate } from '@/i18n/i18n'
import { cloudGitSetupStripModel, cloudGitSetupStripPhase } from './cloud-git-setup-strip-model'

const t = translate
const base = { gitSetupFailed: true, dismissed: false, restarting: false, restarted: false }

describe('GIT-SETUP strip', () => {
  it('is hidden unless git setup failed', () => {
    expect(cloudGitSetupStripPhase({ ...base, gitSetupFailed: false })).toBeNull()
    expect(cloudGitSetupStripPhase({ ...base, gitSetupFailed: false, restarted: true })).toBeNull()
  })

  it('is hidden once dismissed, and shows while failed otherwise', () => {
    expect(cloudGitSetupStripPhase({ ...base, dismissed: true })).toBeNull()
    expect(cloudGitSetupStripPhase(base)).toBe('failed')
  })

  it('says Restarting… during the restart, then that it didn’t fix it if git is still off', () => {
    expect(cloudGitSetupStripPhase({ ...base, restarting: true })).toBe('restarting')
    expect(cloudGitSetupStripPhase({ ...base, restarted: true })).toBe('failedAgain')
  })

  it('never shows for a restart of a workspace whose git works', () => {
    expect(cloudGitSetupStripPhase({ ...base, gitSetupFailed: false, restarting: true })).toBeNull()
  })

  it('uses design-squad’s copy with one Restart action and a session dismiss', () => {
    const failed = cloudGitSetupStripModel('failed', t)
    expect(failed.title).toBe('Commits and pushes are off in this workspace')
    expect(failed.description).toBe(
      'Orca couldn’t set up your GitHub identity here. Restart to try again. Your files are kept, and Orca resumes your agents once it is back.'
    )
    expect(failed.primary).toEqual({ label: 'Restart', action: { kind: 'restart' } })
    expect(failed.dismiss).toBe('Dismiss')
    const restarting = cloudGitSetupStripModel('restarting', t)
    expect(restarting.primary?.busy).toBe(true)
    expect(restarting.noClose).toBe(true)
    const again = cloudGitSetupStripModel('failedAgain', t)
    expect(again.status).toBe('error')
    expect(again.description).toContain('Restarting didn’t fix it.')
    expect(again.primary?.label).toBe('Restart')
  })
})
