import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { selectStoppedWslDistro } from './wsl-host-stopped-status'

/** "<distro> is stopped", the same words the chat and terminal Start offers use. */
export function stoppedWslHostMessage(environmentId: string | null | undefined): string {
  return translate('components.native-chat.hostOutage.stopped', '{{distro}} is stopped', {
    distro: selectStoppedWslDistro(useAppStore.getState(), environmentId) ?? environmentId ?? ''
  })
}

const starting = new Map<string, Promise<boolean>>()

/**
 * Start is the user acting on the host, so it may boot the distro (E9); then the host reconnects.
 * Repeated clicks while it boots share one start.
 */
export function startWslHostAndReloadProjects(environmentId: string): Promise<boolean> {
  const pending = starting.get(environmentId)
  if (pending) {
    return pending
  }
  const start = (async () => {
    try {
      // A Start must not quietly cancel a Remove the user started; that refusal says so (E11).
      await window.api.runtimeEnvironments.wslHosts?.connect({
        environmentId,
        withdrawPendingRemoval: false
      })
      // Why lazy: terminal creation imports this module, and most never start a host.
      const { connectRuntimeHostAndReloadProjects } =
        await import('@/components/status-bar/runtime-environment-explicit-connect')
      return await connectRuntimeHostAndReloadProjects(environmentId)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
      return false
    }
  })().finally(() => starting.delete(environmentId))
  starting.set(environmentId, start)
  return start
}

/** A user act (New Terminal) on a stopped WSL host starts it first; false when it did not start. */
export async function startStoppedWslHostForUserAct(
  environmentId: string | null | undefined
): Promise<boolean> {
  return environmentId && selectStoppedWslDistro(useAppStore.getState(), environmentId)
    ? startWslHostAndReloadProjects(environmentId)
    : true
}
