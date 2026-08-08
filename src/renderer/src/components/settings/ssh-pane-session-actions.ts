import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { terminateSshSessionsWithReconnect } from './ssh-session-termination'

function recordSshInteraction(): void {
  useAppStore.getState().recordFeatureInteraction('ssh')
}

export async function connectSshTarget(targetId: string): Promise<void> {
  try {
    await window.api.ssh.connect({ targetId })
    recordSshInteraction()
  } catch (err) {
    toast.error(
      err instanceof Error
        ? err.message
        : translate('auto.components.settings.SshPane.e95d5ae10e', 'Connection failed')
    )
  }
}

export async function disconnectSshTarget(targetId: string): Promise<void> {
  try {
    await window.api.ssh.disconnect({ targetId })
    recordSshInteraction()
  } catch (err) {
    toast.error(
      err instanceof Error
        ? err.message
        : translate('auto.components.settings.SshPane.a43de1d3ee', 'Disconnect failed')
    )
  }
}

export async function terminateSshTargetSessions(targetId: string): Promise<void> {
  try {
    const result = await terminateSshSessionsWithReconnect(targetId)
    // Why (#12661): offline expired-only terminate is local cleanup only — not a remote kill.
    // Translate here (not in shared) so catalogs extract the notice like other SshPane toasts.
    if (result.abandonedUnreachable === 1) {
      toast.warning(
        translate(
          'auto.components.settings.SshPane.abandonedUnreachableOne',
          '1 abandoned remote session was not killed — reconnect to terminate it.'
        )
      )
      return
    }
    if (result.abandonedUnreachable > 1) {
      toast.warning(
        translate(
          'auto.components.settings.SshPane.abandonedUnreachableMany',
          '{{value0}} abandoned remote sessions were not killed — reconnect to terminate them.',
          { value0: result.abandonedUnreachable }
        )
      )
      return
    }
    toast.success(
      translate('auto.components.settings.SshPane.90e308c98b', 'Remote terminals ended')
    )
  } catch (err) {
    toast.error(
      err instanceof Error
        ? err.message
        : translate('auto.components.settings.SshPane.025e107643', 'Failed to end remote terminals')
    )
  }
}

export async function resetSshTargetRelay(
  targetId: string,
  options: { isMounted: () => boolean; reload: () => Promise<void> }
): Promise<void> {
  try {
    await window.api.ssh.resetRelay({ targetId })
    if (options.isMounted()) {
      toast.success(translate('auto.components.settings.SshPane.db2e48975e', 'Remote relay reset'))
    }
    await options.reload()
  } catch (err) {
    if (options.isMounted()) {
      toast.error(
        err instanceof Error
          ? err.message
          : translate('auto.components.settings.SshPane.2c4ee7332b', 'Failed to reset remote relay')
      )
    }
  }
}
