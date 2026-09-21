import { SSH_TERMINATE_RECONNECT_REQUIRED } from '../../../../shared/constants'
import type { SshTerminateSessionsResult } from '../../../../shared/ssh-types'
import { translate } from '../../i18n/i18n'

export async function terminateSshSessionsWithReconnect(
  targetId: string
): Promise<SshTerminateSessionsResult> {
  try {
    return await window.api.ssh.terminateSessions({ targetId })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (!message.includes(SSH_TERMINATE_RECONNECT_REQUIRED)) {
      throw err
    }
    // Why: disconnect is now non-destructive, so preserved remote PTYs may
    // require a fresh relay attachment before they can be explicitly killed.
    await window.api.ssh.connect({ targetId })
    return await window.api.ssh.terminateSessions({ targetId })
  }
}

/**
 * An offline sweep only tears down local transport, so its remote shells are `unverifiable`, never
 * `exited` (docs/reference/ssh-execution-boundary.md). Reporting plain success there would announce
 * a kill nobody delivered (issue #12661).
 */
export function describeSshTerminateOutcome(outcome: SshTerminateSessionsResult): {
  level: 'success' | 'warning'
  message: string
} {
  if (outcome.unverifiable > 0) {
    return {
      level: 'warning',
      message: translate(
        'auto.components.settings.SshPane.terminateUnverifiable',
        '{{terminals}} remote terminal(s) could not be reached. Reconnect to end them.',
        { terminals: outcome.unverifiable }
      )
    }
  }
  return {
    level: 'success',
    message: translate('auto.components.settings.SshPane.90e308c98b', 'Remote terminals ended')
  }
}
