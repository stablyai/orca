import { translate } from '@/i18n/i18n'
import type { WindowCloseRunningWork } from './window-close-running-work'

/** The close-window prompt's body for the work that raised it. */
export function describeWindowCloseRunningWork(
  work: Exclude<WindowCloseRunningWork, { kind: 'none' }>
): string {
  if (work.kind === 'user-disconnected') {
    return translate(
      'auto.components.Terminal.userDisconnectedHosts',
      'You disconnected {{hosts}}. Closing the window does not end terminals there. Close the window anyway?',
      { hosts: work.hostLabels.join(', ') }
    )
  }
  if (work.kind === 'unverifiable' && work.userDisconnectedHostLabels.length > 0) {
    return translate(
      'auto.components.Terminal.userDisconnectedAndUnreachableHosts',
      'You disconnected {{hosts}}. Closing the window does not end terminals there. Another remote host could not be reached, so Orca cannot tell whether work is still running there. Close the window anyway?',
      { hosts: work.userDisconnectedHostLabels.join(', ') }
    )
  }
  if (work.kind === 'unverifiable') {
    return translate(
      'auto.components.Terminal.b7c1f0a934',
      'A remote host could not be reached, so Orca cannot tell whether work is still running there. Close the window anyway?'
    )
  }
  return translate(
    'auto.components.Terminal.7958465754',
    'There are terminals with running processes. Close the window anyway?'
  )
}
