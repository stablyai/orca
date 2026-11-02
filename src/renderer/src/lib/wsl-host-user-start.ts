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
 * One explicit connect: main hands it to the WSL host, which refuses a host whose Remove is pending
 * instead of keeping it (E11). Repeated clicks while it boots share one start.
 */
export function startWslHostAndReloadProjects(environmentId: string): Promise<boolean> {
  const pending = starting.get(environmentId)
  if (pending) {
    return pending
  }
  // Read now: a failed start can leave the host no longer "stopped". Main's own words can be a
  // probe's command line, so the toast names the distro and where its reason shows instead.
  const failure = translate(
    'components.native-chat.hostOutage.startFailed',
    'Couldn’t start {{distro}}. Check it in Settings → Remote Orca Servers.',
    { distro: useAppStore.getState().wslHostStatuses[environmentId]?.distro ?? environmentId }
  )
  const start = (async () => {
    try {
      // Why lazy: terminal creation imports this module, and most never start a host.
      const { connectRuntimeHostAndReloadProjects } =
        await import('@/components/status-bar/runtime-environment-explicit-connect')
      return await connectRuntimeHostAndReloadProjects(environmentId, failure)
    } catch {
      toast.error(failure)
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
