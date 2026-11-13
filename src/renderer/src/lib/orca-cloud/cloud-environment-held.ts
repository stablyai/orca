// ENV-BUILD-CHURN (d): a workspace that started without its environment's setup (the environment's
// build was below the security floor while a rebuild runs). "Run setup now" runs that environment's
// install script in a new "Setup" terminal of this workspace, as the build would have.
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { dismissCloudSetupNotice, type CloudSetupNoticesRecord } from './cloud-setup-notices-store'

export async function runEnvironmentSetup(
  workspaceId: string,
  record: Pick<CloudSetupNoticesRecord, 'environmentId' | 'notices'>,
  noticeId: string
): Promise<void> {
  const environmentId = record.notices.find((notice) => notice.id === noticeId)?.environmentId
  const answer = environmentId
    ? await window.api.orcaCloudEnvironments?.get(environmentId).catch(() => null)
    : null
  const script = answer?.ok ? answer.data.environment.installScript.trim() : ''
  if (!answer?.ok) {
    toast.error(
      translate(
        'orcaCloud.setupNotices.environmentSetupUnreadable',
        'Couldn’t read the environment’s setup. Try again in a moment.'
      )
    )
    return
  }
  if (script) {
    const store = useAppStore.getState()
    const tab = store.createTab(workspaceId, undefined, undefined, {
      pendingStartup: { command: script }
    })
    store.setTabCustomTitle(tab.id, translate('worktree.setupTerminalTitle', 'Setup'))
  }
  // An automatic environment has no script: its dependencies install from the lockfile on rebuild,
  // so there is nothing to run here; the line goes either way.
  dismissCloudSetupNotice(record.environmentId, noticeId)
}
