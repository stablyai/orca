// What a failed environment build's summary offers besides Try again. Install-script
// failures and clone failures caused by repo contents go to an agent in a cloud workspace on the last
// good build; a clone that couldn't reach the repo goes to GitHub (an agent can't grant access).
import { toast } from 'sonner'
import type { Translate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { cloudEnvironmentFixComposerData } from '@/lib/cloud-environment-fix-with-agent'
import { classifyCloneFailure, cloneFailureRepoName } from '@/lib/cloud-environment-clone-failure'
import { stepLabel } from './cloud-environment-copy'
import type { EnvironmentBuildView, EnvironmentView } from './cloud-environment-types'

/** The prompt carries this much of the visible log (it is redacted and capped again downstream). */
const LOG_TAIL_LINES = 80

type EnvironmentFailureFix = {
  onFixWithAgent: (() => void) | null
  onGiveAccess: (() => void) | null
}

const NONE: EnvironmentFailureFix = { onFixWithAgent: null, onGiveAccess: null }

export function environmentFailureFix(args: {
  build: EnvironmentBuildView | undefined
  /** The latest build's visible log, or null when another build's log is open. */
  logLines: readonly string[] | null
  environment: Pick<EnvironmentView, 'installScript'>
  /** The local project matching the environment's first repo, if any. */
  repoId: string | null
  t: Translate
}): EnvironmentFailureFix {
  const { build, logLines, environment, repoId, t } = args
  if (build?.status !== 'failed') {
    return NONE
  }
  const log = logLines ? logLines.slice(-LOG_TAIL_LINES).join('\n') : undefined
  const openFix = (focus: 'install' | 'clone', lead: string) => (): void => {
    useAppStore.getState().openModal(
      'new-workspace-composer',
      cloudEnvironmentFixComposerData({
        repoId,
        lead,
        focus,
        installScript: environment.installScript,
        log
      })
    )
  }
  if (build.failedStep === 'install') {
    return {
      onFixWithAgent: openFix(
        'install',
        t(
          'cloudEnvironment.failure.fixPrompt',
          'The environment build failed at {{step}}. Fix the install script so the build succeeds.',
          { step: stepLabel('install', t) }
        )
      ),
      onGiveAccess: null
    }
  }
  // A clone failure needs its log to tell repo contents from access; without it, offer neither.
  if (build.failedStep !== 'clone' || !logLines) {
    return NONE
  }
  const failure = classifyCloneFailure(logLines)
  const repo = cloneFailureRepoName(failure.repoUrl)
  switch (failure.kind) {
    case 'content':
      return {
        onFixWithAgent: openFix(
          'clone',
          t(
            'cloudEnvironment.failure.fixClonePrompt',
            'The environment build failed while cloning {{repo}}. Fix the repository setup so the clone succeeds.',
            { repo: repo ?? t('cloudEnvironment.failure.aRepository', 'a repository') }
          )
        ),
        onGiveAccess: null
      }
    case 'access': {
      const repoUrl = failure.repoUrl
      return {
        onFixWithAgent: null,
        onGiveAccess: (): void => {
          void window.api.orcaCloudWorkspace
            .connectGitHub(repoUrl ? { repoUrl } : undefined)
            .catch(() => null)
            .then((result) => {
              if (!result?.ok) {
                toast.error(
                  t(
                    'cloudEnvironment.failure.giveAccessFailed',
                    'Couldn’t open GitHub. Try again in a moment.'
                  )
                )
              }
            })
        }
      }
    }
    case 'unknown':
      return NONE
  }
}
