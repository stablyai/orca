import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { CloudDotState } from '@/lib/orca-cloud/orca-cloud-workspace-state'
import { archivedSnapshotLine } from './archive-snapshot-copy'
import type { CloudGlyphState } from './CloudStatusGlyph'

export function cloudStateLabel(state: CloudDotState, t: Translate = translate): string {
  switch (state) {
    case 'running':
      return t('orcaCloudWorkspace.state.running', 'Running')
    case 'sleeping':
      return t('orcaCloudWorkspace.state.asleep', 'Asleep')
    case 'waking':
      return t('orcaCloudWorkspace.state.waking', 'Waking')
    case 'starting':
      return t('orcaCloudWorkspace.state.starting', 'Starting')
    case 'unresponsive':
      return t('orcaCloudWorkspace.state.notResponding', 'Not responding')
    case 'archived':
      return t('orcaCloudWorkspace.state.archived', 'Archived')
    case 'failed':
      return t('orcaCloudWorkspace.state.failed', 'Couldn’t start')
    case 'wakeFailed':
      return t('orcaCloudWorkspace.state.wakeFailed', 'Couldn’t wake')
    case 'unknown':
      return t('orcaCloudWorkspace.state.unknown', 'Checking…')
  }
}

/** The cloud glyph's state name: the dot's states plus its two transitions. */
export function cloudGlyphStateLabel(state: CloudGlyphState, t: Translate = translate): string {
  if (state === 'goingToSleep') {
    return t('orcaCloudWorkspace.state.goingToSleep', 'Going to sleep…')
  }
  if (state === 'restarting') {
    return t('orcaCloudWorkspace.state.restarting', 'Restarting')
  }
  return cloudStateLabel(state, t)
}

/** One line under the state in the status panel; null where the state says enough on its own. */
export function cloudStateDetail(
  state: CloudDotState,
  t: Translate = translate,
  /** An archived workspace's kept-until date: the day its snapshot is deleted. */
  keptUntil?: number | null
): string | null {
  switch (state) {
    case 'sleeping':
      return t(
        'orcaCloudWorkspace.detail.asleepSafe',
        'Your files and chats are safe. Opening it wakes it.'
      )
    case 'waking':
      return t('orcaCloudWorkspace.detail.waking', 'Waking…')
    case 'starting':
      // Same words as the creating row in the sidebar.
      return t('auto.lib.pendingWorktreeCreation.startingSandbox', 'Starting sandbox…')
    case 'unresponsive':
      return t(
        'orcaCloudWorkspace.detail.restartToRecover',
        'Restart to recover. Files are kept and Orca resumes your agents after the restart.'
      )
    case 'archived':
      // Same words as the archived view: what the snapshot holds and when it is deleted.
      return archivedSnapshotLine(t, keptUntil)
    case 'failed':
      return t(
        'orcaCloudWorkspace.detail.startFailed',
        'The sandbox couldn’t start. Nothing was lost.'
      )
    case 'wakeFailed':
      return t(
        'orcaCloudWorkspace.detail.wakeFailed',
        'Couldn’t wake the sandbox. Your files and chats are safe.'
      )
    case 'running':
    case 'unknown':
      return null
  }
}
