// What the in-workspace setup notices do: install the GitHub App so a read-only repository can
// push (then re-check on their own once GitHub's install webhook binds it), and run a setup script
// the create skipped.
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { checkRuntimeHooks } from '@/runtime/repo-hooks/runtime-hooks-client'
import { runVmEnvironmentCheck } from '@/runtime/ephemeral-vm/ephemeral-vm-environment-check'
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
 * sandbox's check again and drops the push line, and the can't-reach line (GH-FETCH-REASON), that
 * pass now. Returns 'granted' when nothing is left failing, 'waiting' while GitHub hasn't confirmed
 * yet, 'refused' when the installation landed but the sandbox still can't push or reach origin
 * (a workspace started before the install needs a restart to use it).
 */
/**
 * LIVE-GIT-ACCESS: asks the control plane to put the GitHub App's repo token into this running workspace
 * (live egress policy + the VM's git header), so an install made after it started works without a
 * restart. True when it is live now; false when there's nothing to apply yet or it couldn't be asked.
 */
export async function applyLiveGitAccess(workspaceId: string | undefined): Promise<boolean> {
  const api = cloudWorkspaceApi()
  if (!workspaceId || !api?.refreshGitAccess) {
    return false
  }
  const result = await api.refreshGitAccess({ workspaceId }).catch(() => null)
  return Boolean(result?.ok && result.value.applied)
}

export async function recheckCloudPushAccess(
  environmentId: string,
  options: { workspaceId?: string } = {}
): Promise<'granted' | 'waiting' | 'refused'> {
  const record = getCloudSetupNoticesRecord(environmentId)
  const watched = new Set(
    (record?.notices ?? [])
      .filter((notice) => notice.kind === 'push' || notice.kind === 'fetch')
      .map((notice) => notice.kind)
  )
  if (!record?.repoUrl || watched.size === 0) {
    return 'granted'
  }
  invalidateOrcaCloudRepoAccess(record.repoUrl)
  const access = await fetchOrcaCloudRepoAccess(record.repoUrl, { force: true })
  if (access?.access !== 'granted') {
    return 'waiting'
  }
  // The App reaches the repository: make this running workspace use it before checking again.
  await applyLiveGitAccess(options.workspaceId)
  const result = await runVmEnvironmentCheck(null, environmentId, record.path)
  const passed = (id: string): boolean => {
    const check = result.checks.find((candidate) => candidate.id === id)
    return Boolean(check) && check!.status !== 'fail'
  }
  const cleared = new Set<string>()
  if (watched.has('fetch') && passed('git.fetch')) {
    cleared.add('fetch')
  }
  // A push is only checked once origin answers: a fetch failure stops the doctor before it.
  if (watched.has('push') && passed('git.push')) {
    cleared.add('push')
  }
  const current = getCloudSetupNoticesRecord(environmentId)
  if (current && cleared.size > 0) {
    setCloudSetupNotices({
      ...current,
      notices: current.notices.filter((notice) => !cleared.has(notice.kind))
    })
  }
  if (cleared.size < watched.size) {
    return 'refused'
  }
  toast.success(
    watched.has('push')
      ? translate('orcaCloud.setupNotices.pushReady', 'Orca Cloud can push to {{repo}} now.', {
          repo: repoSlug(record.repoUrl)
        })
      : translate('orcaCloud.setupNotices.fetchReady', 'This workspace can reach {{repo}} now.', {
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
