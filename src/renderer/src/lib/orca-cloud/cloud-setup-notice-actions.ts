// What the in-workspace setup notices do: install the GitHub App so a read-only repository can
// push (then re-check on their own once GitHub's install webhook binds it), and run a setup script
// the create skipped.
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { checkRuntimeHooks } from '@/runtime/repo-hooks/runtime-hooks-client'
import { runVmEnvironmentCheck } from '@/lib/ephemeral-vm-environment-check'
import { cloudWorkspaceApi } from './orca-cloud-workspace-store'
import {
  fetchOrcaCloudRepoAccess,
  invalidateOrcaCloudRepoAccess
} from './use-orca-cloud-repo-access'
import {
  dismissCloudSetupNotice,
  getCloudSetupNoticesRecord,
  setCloudSetupNotices,
  type CloudSetupNoticesRecord
} from './cloud-setup-notices-store'

/** owner/repo from https://github.com/<owner>/<repo>. */
export function repoSlug(repoUrl: string): string {
  return repoUrl.replace(/^https:\/\/github\.com\//, '')
}

export function repoOwner(repoUrl: string): string {
  return repoSlug(repoUrl).split('/')[0] ?? ''
}

/** GitHub's install page, preselecting this repository (#246). False when it couldn't open. */
export async function openOrcaGitHubAppInstall(repoUrl: string): Promise<boolean> {
  const result = await cloudWorkspaceApi()
    ?.connectGitHub({ repoUrl })
    .catch(() => null)
  if (!result?.ok) {
    toast.error(
      translate(
        'orcaCloud.setupNotices.installFailed',
        'Couldn’t open GitHub. Check your connection and try again.'
      )
    )
    return false
  }
  return true
}

/**
 * Once the App's installation covers the repository (the install webhook bound it), runs the
 * sandbox's push check again and drops the notice when the push is now authorized. Returns
 * 'granted' when the push works, 'waiting' while GitHub hasn't confirmed yet, 'refused' when the
 * installation landed but the sandbox still can't push.
 */
export async function recheckCloudPushAccess(
  environmentId: string
): Promise<'granted' | 'waiting' | 'refused'> {
  const record = getCloudSetupNoticesRecord(environmentId)
  if (!record?.repoUrl || !record.notices.some((notice) => notice.kind === 'push')) {
    return 'granted'
  }
  invalidateOrcaCloudRepoAccess(record.repoUrl)
  const access = await fetchOrcaCloudRepoAccess(record.repoUrl, { force: true })
  if (access?.access !== 'granted') {
    return 'waiting'
  }
  const result = await runVmEnvironmentCheck(null, environmentId, record.path)
  const push = result.checks.find((check) => check.id === 'git.push')
  const current = getCloudSetupNoticesRecord(environmentId)
  if (!push || push.status === 'fail') {
    return 'refused'
  }
  if (current) {
    setCloudSetupNotices({
      ...current,
      notices: current.notices.filter((notice) => notice.kind !== 'push')
    })
  }
  toast.success(
    translate('orcaCloud.setupNotices.pushReady', 'Orca Cloud can push to {{repo}} now.', {
      repo: repoSlug(record.repoUrl)
    })
  )
  return 'granted'
}

/**
 * Runs the project's setup script in a new "Setup" terminal of the workspace, as a create with
 * setup on would have. The script is read from the sandbox's own orca.yaml, never from here.
 */
export async function runCloudSetupScript(
  workspaceId: string,
  record: Pick<CloudSetupNoticesRecord, 'environmentId' | 'repoId' | 'hostId'>,
  noticeId: string
): Promise<void> {
  let script: string | undefined
  try {
    if (record.hostId && record.repoId) {
      const hooks = await checkRuntimeHooks(record.hostId, record.repoId)
      script = hooks.hooks?.scripts?.setup?.trim() || undefined
    }
  } catch (error) {
    console.warn('[orca-cloud] Could not read the setup script:', error)
  }
  if (!script) {
    toast.error(
      translate(
        'orcaCloud.setupNotices.setupMissing',
        'Couldn’t read the setup script from orca.yaml in this workspace.'
      )
    )
    return
  }
  const store = useAppStore.getState()
  const tab = store.createTab(workspaceId, undefined, undefined, {
    pendingStartup: { command: script }
  })
  store.setTabCustomTitle(tab.id, translate('worktree.setupTerminalTitle', 'Setup'))
  dismissCloudSetupNotice(record.environmentId, noticeId)
}
