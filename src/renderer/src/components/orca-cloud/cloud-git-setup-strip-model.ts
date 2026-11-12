// GIT-SETUP copy (design-squad): the teammates' git identities couldn't be installed after create
// (#468), so the VM refuses commits and pushes. One strip per workspace, in the sign-in strip's
// shape. Restart is the retry: the boot installs the identities again and clears the flag.
import type { Translate } from '@/i18n/use-translate'
import type { CloudStripModel } from '../agent-sign-in-strip/cloud-agent-strip-model'

export type CloudGitSetupStripPhase = 'failed' | 'restarting' | 'failedAgain'

export type CloudGitSetupStripInput = {
  gitSetupFailed: boolean
  dismissed: boolean
  restarting: boolean
  /** A restart finished while git setup had failed. */
  restarted: boolean
}

/** Which strip shows, or null: only while git setup has failed and the strip isn't dismissed. */
export function cloudGitSetupStripPhase(
  input: CloudGitSetupStripInput
): CloudGitSetupStripPhase | null {
  if (input.restarting && (input.gitSetupFailed || input.restarted)) {
    return 'restarting'
  }
  if (!input.gitSetupFailed || input.dismissed) {
    return null
  }
  return input.restarted ? 'failedAgain' : 'failed'
}

export function cloudGitSetupStripModel(
  phase: CloudGitSetupStripPhase,
  t: Translate
): CloudStripModel {
  const title = t(
    'orcaCloudWorkspace.gitSetup.title',
    'Commits and pushes are off in this workspace'
  )
  const restart = t('orcaCloudWorkspace.restart', 'Restart')
  const base = { title, code: null, paste: null, otherWays: false }
  if (phase === 'restarting') {
    const restarting = t('orcaCloudWorkspace.restarting', 'Restarting…')
    return {
      ...base,
      status: 'busy',
      // The body's last sentence: what the restart keeps while it runs.
      detail: t(
        'orcaCloudWorkspace.gitSetup.restartingDetail',
        'Your files are kept, and Orca resumes your agents once it is back.'
      ),
      description: null,
      primary: { label: restarting, action: { kind: 'restart' }, busy: true },
      noClose: true,
      announcement: restarting
    }
  }
  const body =
    phase === 'failedAgain'
      ? {
          detail: t(
            'orcaCloudWorkspace.gitSetup.failedAgainShort',
            'Restarting didn’t fix it. Reading, diffs and other read-only git still work.'
          ),
          description: t(
            'orcaCloudWorkspace.gitSetup.failedAgain',
            'Restarting didn’t fix it. You can keep working; reading, diffs and other read-only git still work. Restart again later.'
          )
        }
      : {
          detail: t(
            'orcaCloudWorkspace.gitSetup.detailShort',
            'Orca couldn’t set up your GitHub identity here. Restart to try again.'
          ),
          description: t(
            'orcaCloudWorkspace.gitSetup.detail',
            'Orca couldn’t set up your GitHub identity here. Restart to try again. Your files are kept, and Orca resumes your agents once it is back.'
          )
        }
  return {
    ...base,
    status: phase === 'failedAgain' ? 'error' : 'warning',
    ...body,
    primary: { label: restart, action: { kind: 'restart' } },
    dismiss: t('orcaCloudWorkspace.dismiss', 'Dismiss'),
    announcement: `${title}. ${body.description}`
  }
}
