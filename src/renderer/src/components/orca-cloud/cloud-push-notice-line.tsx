// The "can't push" line: Install only where installing can work, a request to
// copy for an owner once one was asked, Check again where the App already reaches the repository,
// and, where only an owner can install, a request to copy for them with no Install button.
import { Check, Copy, GitPullRequestArrow, Loader2, RefreshCw, RotateCw } from 'lucide-react'
import type { Translate } from '@/i18n/use-translate'
import { repoOwner, repoSlug } from '@/lib/orca-cloud/cloud-setup-notice-actions'
import type { CloudPushAccess } from '@/lib/orca-cloud/cloud-push-access'
import { ownerRequestLabel } from '@/lib/orca-cloud/owner-request'
import type { CloudSetupNoticeLine } from './CloudSetupNotices'

export type CloudPushLineHandlers = {
  access: CloudPushAccess
  install: () => void
  installing: boolean
  copyRequest: () => void
  copied?: boolean
  recheck: () => void
  rechecking?: boolean
  /** The live refresh ran and it still can't push: Restart, not another Check again. */
  needsRestart?: boolean
  restart?: () => void
}

/** Copy a request for an owner (owner-request.ts), reading "Copied" for a moment after. */
function copyRequestAction(
  h: CloudPushLineHandlers,
  t: Translate
): NonNullable<CloudSetupNoticeLine['action']> {
  return {
    label: ownerRequestLabel(h.copied === true, t),
    icon: h.copied ? <Check /> : <Copy />,
    run: h.copyRequest
  }
}

export function cloudPushNoticeLine(
  repoUrl: string | null,
  t: Translate,
  h: CloudPushLineHandlers
): CloudSetupNoticeLine {
  if (!repoUrl) {
    return {
      text: t('orcaCloud.setupNotices.pushRefused', 'Orca Cloud can’t push from this workspace.'),
      action: null
    }
  }
  const repo = repoSlug(repoUrl)
  const owner = repoOwner(repoUrl)
  switch (h.access) {
    case 'install':
      return {
        text: t(
          'orcaCloud.setupNotices.pushNeedsApp',
          'Orca Cloud can read {{repo}} but can’t push yet. Install the Orca GitHub App on {{owner}} to push.',
          { repo, owner }
        ),
        // The App's install page, not a sign-in: no Copy link beside it.
        action: {
          label: h.installing
            ? t('orcaCloud.setupNotices.waitingForGitHub', 'Waiting for GitHub…')
            : t('orcaCloud.setupNotices.installOn', 'Install on {{owner}}', { owner }),
          icon: h.installing ? <Loader2 className="animate-spin" /> : <GitPullRequestArrow />,
          run: h.install,
          pending: h.installing
        }
      }
    case 'requested':
      return {
        text: t(
          'orcaCloud.setupNotices.pushRequested',
          'Orca Cloud can read {{repo}} but can’t push yet. An owner of {{owner}} has been asked to approve the Orca GitHub App.',
          { repo, owner }
        ),
        action: copyRequestAction(h, t)
      }
    case 'cantInstall':
      return {
        text: t(
          'orcaCloud.setupNotices.pushCantInstall',
          'Orca Cloud can read {{repo}} but can’t push to it.',
          { repo }
        ),
        description: t(
          'orcaCloud.setupNotices.pushCantInstallMeaning',
          'Pushing needs the Orca GitHub App on {{owner}}. Ask an owner of {{owner}} to install it.',
          { owner }
        ),
        // No Install: only an owner can. The same request an owner would get once asked.
        action: copyRequestAction(h, t)
      }
    case 'granted':
      if (h.needsRestart && h.restart) {
        return {
          text: t(
            'orcaCloud.setupNotices.pushNeedsRestart',
            'Orca Cloud can push to {{repo}} now, but this workspace can’t use the new access yet.',
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
      return {
        text: t('orcaCloud.setupNotices.pushNotYet', 'Orca Cloud can’t push to {{repo}} yet.', {
          repo
        }),
        // The App reaches it, so a fresh sandbox's credential may just have been late.
        action: {
          label: h.rechecking
            ? t('orcaCloud.setupNotices.checking', 'Checking…')
            : t('orcaCloud.setupNotices.checkAgain', 'Check again'),
          icon: h.rechecking ? <Loader2 className="animate-spin" /> : <RefreshCw />,
          run: h.recheck,
          ...(h.rechecking ? { pending: true } : {})
        }
      }
    case 'checking':
    case 'unknown':
      return {
        text: t('orcaCloud.setupNotices.pushNotYet', 'Orca Cloud can’t push to {{repo}} yet.', {
          repo
        }),
        action: null
      }
  }
}
