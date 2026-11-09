import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { CloudDotState } from '@/lib/orca-cloud/orca-cloud-workspace-state'

export function cloudStateLabel(state: CloudDotState, t: Translate = translate): string {
  switch (state) {
    case 'running':
      return t('orcaCloudWorkspace.state.running', 'Running')
    case 'sleeping':
      return t('orcaCloudWorkspace.state.asleep', 'Asleep')
    case 'waking':
      return t('orcaCloudWorkspace.state.waking', 'Waking')
    case 'unresponsive':
      return t('orcaCloudWorkspace.state.notResponding', 'Not responding')
    case 'archived':
      return t('orcaCloudWorkspace.state.archived', 'Archived')
    case 'failed':
      return t('orcaCloudWorkspace.state.failed', 'Couldn’t start')
    case 'unknown':
      return t('orcaCloudWorkspace.state.unknown', 'Checking…')
  }
}

/** One line under the state in the status panel; null where the state says enough on its own. */
export function cloudStateDetail(state: CloudDotState, t: Translate = translate): string | null {
  switch (state) {
    case 'sleeping':
      return t(
        'orcaCloudWorkspace.detail.asleep',
        'Files and chats are saved. Opening it wakes it.'
      )
    case 'waking':
      return t('orcaCloudWorkspace.detail.waking', 'Waking…')
    case 'unresponsive':
      return t('orcaCloudWorkspace.detail.restartKeeps', 'Restart keeps your files; agents resume.')
    case 'archived':
      return t(
        'orcaCloudWorkspace.detail.archived',
        'Kept as a snapshot. Unarchive to work in it again.'
      )
    case 'failed':
      return t('orcaCloudWorkspace.detail.failed', 'The last start failed. Your files are saved.')
    case 'running':
    case 'unknown':
      return null
  }
}
