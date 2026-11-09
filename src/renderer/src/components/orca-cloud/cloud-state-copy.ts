import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { CloudDotState } from '@/lib/orca-cloud/orca-cloud-workspace-state'

export function cloudStateLabel(state: CloudDotState, t: Translate = translate): string {
  switch (state) {
    case 'running':
      return t('orcaCloudWorkspace.state.running', 'Running')
    case 'sleeping':
      return t('orcaCloudWorkspace.state.sleeping', 'Sleeping')
    case 'waking':
      return t('orcaCloudWorkspace.state.waking', 'Waking')
    case 'unresponsive':
      return t('orcaCloudWorkspace.state.unresponsive', 'Unresponsive')
    case 'archived':
      return t('orcaCloudWorkspace.state.archived', 'Archived')
    case 'failed':
      return t('orcaCloudWorkspace.state.failed', 'Couldn’t start')
    case 'unknown':
      return t('orcaCloudWorkspace.state.unknown', 'Checking…')
  }
}

/** One line under the state in the status panel: what this state means for the user's work. */
export function cloudStateDetail(state: CloudDotState, t: Translate = translate): string {
  switch (state) {
    case 'running':
      return t('orcaCloudWorkspace.detail.running', 'Agents and terminals keep running while your laptop sleeps.')
    case 'sleeping':
      return t(
        'orcaCloudWorkspace.detail.sleeping',
        'Files and chats are saved. Opening the workspace wakes it in a few seconds.'
      )
    case 'waking':
      return t('orcaCloudWorkspace.detail.waking', 'Starting the VM from its saved disk.')
    case 'unresponsive':
      return t(
        'orcaCloudWorkspace.detail.unresponsive',
        'The VM stopped answering. Restart keeps your files; interrupted agents continue.'
      )
    case 'archived':
      return t(
        'orcaCloudWorkspace.detail.archived',
        'Stopped and kept as a snapshot. Unarchive to work in it again.'
      )
    case 'failed':
      return t('orcaCloudWorkspace.detail.failed', 'The last start failed. Your files are safe.')
    case 'unknown':
      return t('orcaCloudWorkspace.detail.unknown', 'Asking Orca Cloud for the latest status.')
  }
}
