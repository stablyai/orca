// The "can't reach origin" line (GH-FETCH-REASON). "Can't reach … right now" with Check again reads
// as transient, so it's kept for what is: the network, or no answer yet. Where Orca's GitHub app
// can't see the repository, the line says so and offers what fixes it (Grant access, or a request
// for an owner). Where the app can see it but this workspace still can't, it says Restart.
import { Check, Copy, GitPullRequestArrow, Loader2, RefreshCw, RotateCw } from 'lucide-react'
import type { Translate } from '@/i18n/use-translate'
import { repoOwner, repoSlug } from '@/lib/orca-cloud/cloud-setup-notice-actions'
import type { CloudPushAccess } from '@/lib/orca-cloud/cloud-push-access'
import { ownerRequestLabel } from '@/lib/orca-cloud/owner-request'
import type { EnvironmentDoctorCheck } from '../../../../shared/workspace-setup/environment-doctor/environment-doctor-types'
import type { CloudSetupNoticeLine } from './CloudSetupNotices'

type CloudFetchLineHandlers = {
  /** What the control plane says about Orca's GitHub app and this repository. */
  access: CloudPushAccess
  install: () => void
  installing: boolean
  copyRequest: () => void
  copied?: boolean
  /** LIVE-GIT-ACCESS: the live refresh ran and origin still refused. */
  needsRestart?: boolean
  restart?: () => void
  recheck?: () => void
  checking?: boolean
}

/** The doctor's reason (GH-FETCH-REASON): git refused, or said the repository isn't there. */
function refusedByGitHub(check: EnvironmentDoctorCheck): boolean {
  return check.code === 'remoteDenied' || check.code === 'remoteNotFound'
}

function transientLine(
  repoUrl: string | null,
  t: Translate,
  h: CloudFetchLineHandlers
): CloudSetupNoticeLine {
  return {
    text: repoUrl
      ? t(
          'orcaCloud.setupNotices.fetchFailed',
          'This workspace can’t reach {{repo}} on GitHub right now.',
          { repo: repoSlug(repoUrl) }
        )
      : t(
          'orcaCloud.setupNotices.fetchFailedNoRepo',
          'This workspace can’t reach its Git remote right now.'
        ),
    description: t(
      'orcaCloud.setupNotices.fetchFailedMeaning',
      'Pulls and pushes won’t work until it can.'
    ),
    action: h.recheck
      ? {
          label: h.checking
            ? t('orcaCloud.setupNotices.checking', 'Checking…')
            : t('orcaCloud.setupNotices.checkAgain', 'Check again'),
          icon: h.checking ? <Loader2 className="animate-spin" /> : <RefreshCw />,
          run: h.recheck,
          ...(h.checking ? { pending: true } : {})
        }
      : null
  }
}

export function cloudFetchNoticeLine(
  check: EnvironmentDoctorCheck,
  repoUrl: string | null,
  t: Translate,
  h: CloudFetchLineHandlers
): CloudSetupNoticeLine {
  // The network (DNS, connect, timeout) is worth a Check again whatever the app can see.
  if (!repoUrl || check.code === 'remoteUnreachable') {
    return transientLine(repoUrl, t, h)
  }
  const repo = repoSlug(repoUrl)
  const owner = repoOwner(repoUrl)
  const noAccess = t(
    'orcaCloud.setupNotices.fetchNoAccess',
    'Orca’s GitHub app doesn’t have access to {{repo}}.',
    { repo }
  )
  const copyRequest = {
    label: ownerRequestLabel(h.copied === true, t),
    icon: h.copied ? <Check /> : <Copy />,
    run: h.copyRequest
  }
  switch (h.access) {
    case 'install':
      return {
        text: noAccess,
        description: t(
          'orcaCloud.setupNotices.fetchNoAccessMeaning',
          'Pulls and pushes won’t work until it does.'
        ),
        action: {
          label: h.installing
            ? t('orcaCloud.setupNotices.waitingForGitHub', 'Waiting for GitHub…')
            : t('orcaCloud.setupNotices.grantAccess', 'Give Orca access'),
          icon: h.installing ? <Loader2 className="animate-spin" /> : <GitPullRequestArrow />,
          run: h.install,
          pending: h.installing
        }
      }
    case 'requested':
      return {
        text: noAccess,
        description: t(
          'orcaCloud.setupNotices.fetchNoAccessRequested',
          'An owner of {{owner}} has been asked to approve it. Pulls and pushes won’t work until they do.',
          { owner }
        ),
        action: copyRequest
      }
    case 'cantInstall':
      return {
        text: noAccess,
        description: t(
          'orcaCloud.setupNotices.fetchNoAccessCantInstall',
          'Only an owner of {{owner}} can give Orca access. Pulls and pushes won’t work until they do.',
          { owner }
        ),
        action: copyRequest
      }
    case 'granted':
      // The app reaches the repository and GitHub still refused: this workspace started without the
      // app's credential (it was installed after the start). A restart picks it up.
      if ((refusedByGitHub(check) || h.needsRestart) && h.restart) {
        return {
          text: t(
            'orcaCloud.setupNotices.fetchNeedsRestart',
            'This workspace can’t use Orca’s access to {{repo}} yet.',
            { repo }
          ),
          description: t(
            'orcaCloud.setupNotices.newAccessNeedsRestart',
            'Restart the workspace to use the new access. Your files are kept.'
          ),
          action: {
            label: t('orcaCloudWorkspace.restart', 'Restart'),
            icon: <RotateCw />,
            run: h.restart
          }
        }
      }
      return transientLine(repoUrl, t, h)
    case 'checking':
    case 'unknown':
      return transientLine(repoUrl, t, h)
  }
}
