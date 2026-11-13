// ENV-NOTICE-ACTIONS: what the "can't push" notice can offer, from what the control plane says about
// the Orca GitHub App's access (repo-access) and what the person's own gh login says about installing
// it. Install only shows where installing can work; a request already sent offers a copy for an owner;
// a public repository someone else owns (octocat/Hello-World) gets a request to copy, no Install.
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { HostedGithubRepoAccessResponse } from '../../../../shared/hosted-sandbox/hosted-github-wire'
import type { GitHubInstallRights } from '../../../../shared/hosted-sandbox/cloud-workspace-api'
import { cloudWorkspaceApi } from './orca-cloud-workspace-store'
import { fetchOrcaCloudRepoAccess } from './use-orca-cloud-repo-access'
import { repoSlug } from './cloud-setup-notice-actions'

/**
 * `install`: Install on {owner}. `requested`: an owner was asked; copy a request for them.
 * `cantInstall`: only the owner's admins can install, and this person isn't one. `granted`: the App
 * reaches the repository, so the refusal is something else (Check again). `checking`: no answer yet.
 * `unknown`: couldn't ask (offline, signed out).
 */
export type CloudPushAccess =
  | 'install'
  | 'requested'
  | 'cantInstall'
  | 'granted'
  | 'checking'
  | 'unknown'

export function cloudPushAccess(
  access: HostedGithubRepoAccessResponse['access'] | null | undefined,
  rights: GitHubInstallRights | null
): CloudPushAccess {
  switch (access) {
    case undefined:
      return 'checking'
    case null:
      return 'unknown'
    case 'requested':
      return 'requested'
    case 'granted':
      return 'granted'
    case 'missing':
      // The control plane minted an install page. An org member who isn't an admin still gets
      // somewhere (GitHub turns the install into a request for an owner); a collaborator on someone's
      // personal repository doesn't.
      return rights && !rights.admin && rights.ownerType === 'User' ? 'cantInstall' : 'install'
    case 'public':
      // Readable by anyone, so readability says nothing about the person: only admin rights do.
      return rights?.admin ? 'install' : 'cantInstall'
  }
}

/** The control plane's answer plus, where it decides the button, the person's install rights. */
export async function fetchCloudPushAccess(
  repoUrl: string,
  options: { force?: boolean } = {}
): Promise<CloudPushAccess> {
  const answer = await fetchOrcaCloudRepoAccess(repoUrl, options)
  const access = answer?.access ?? null
  if (access !== 'missing' && access !== 'public') {
    return cloudPushAccess(access, null)
  }
  const rights = await cloudWorkspaceApi()
    ?.gitHubInstallRights({ repoUrl })
    .then((result) => (result.ok ? result.value : null))
    .catch(() => null)
  return cloudPushAccess(access, rights ?? null)
}

/** A message for an owner of the repository's org, with the install page that preselects it. */
export async function copyOwnerPushRequest(repoUrl: string): Promise<boolean> {
  // The install page the control plane minted for this repository (preselects it), if any.
  const link = (await fetchOrcaCloudRepoAccess(repoUrl).catch(() => null))?.installUrl ?? null
  const message = translate(
    'orcaCloud.setupNotices.pushRequestMessage',
    'Could you give the Orca GitHub App access to {{repo}}? Orca Cloud needs it to push from workspaces on this repository.',
    { repo: repoSlug(repoUrl) }
  )
  try {
    await window.api.ui.writeClipboardText(link ? `${message}\n${link}` : message)
    return true
  } catch {
    toast.error(translate('orcaCloud.setupNotices.pushRequestCopyFailed', 'Couldn’t copy it.'))
    return false
  }
}
