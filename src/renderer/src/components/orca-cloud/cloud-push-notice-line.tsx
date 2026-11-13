// The "can't push" line (ENV-NOTICE-ACTIONS): Install only where installing can work, a request to
// copy for an owner once one was asked, Check again where the App already reaches the repository,
// and, where only an owner can install, a request to copy for them with no Install button.
import { Check, Copy, GitPullRequestArrow, Loader2, RefreshCw } from 'lucide-react'
import type { Translate } from '@/i18n/use-translate'
import { repoOwner, repoSlug } from '@/lib/orca-cloud/cloud-setup-notice-actions'
import type { CloudPushAccess } from '@/lib/orca-cloud/cloud-push-access'
import type { CloudSetupNoticeLine } from './CloudSetupNotices'

export type CloudPushLineHandlers = {
  access: CloudPushAccess
  install: () => void
  installing: boolean
  copyRequest: () => void
  copied?: boolean
  recheck: () => void
  rechecking?: boolean
}

/** Copy a request for an owner (pushRequestMessage), reading "Copied" for a moment after. */
function copyRequestAction(
  h: CloudPushLineHandlers,
  t: Translate
): NonNullable<CloudSetupNoticeLine['action']> {
  return {
    label: h.copied
      ? t('orcaCloud.setupNotices.copied', 'Copied')
      : t('orcaCloud.setupNotices.copyRequest', 'Copy request for an owner'),
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
        // The App's install page, not a sign-in: no Copy link beside it (AUTH-ONLY-COPY-LINK).
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
