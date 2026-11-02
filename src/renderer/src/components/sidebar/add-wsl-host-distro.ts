import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { WslHostAddResult } from '../../../../shared/wsl-host-types'
import { WSL_HOST_ADD_REFUSAL_COPY } from '../../../../shared/wsl-host-failure-copy'

/** Adds a WSL distro as a host, then refreshes the hosts the window lists. */
export async function addWslHostDistro(args: {
  distro: string
  startIfStopped: boolean
}): Promise<WslHostAddResult> {
  const api = window.api.runtimeEnvironments?.wslHosts
  if (!api) {
    return {
      ok: false,
      kind: 'disabled',
      message: WSL_HOST_ADD_REFUSAL_COPY.turnedOff,
      errorCode: 'turnedOff'
    }
  }
  const result = await api.add(args)
  if (!result.ok) {
    return result
  }
  const { setRuntimeEnvironments, readRuntimeHostStatusSnapshots } = useAppStore.getState()
  setRuntimeEnvironments(await window.api.runtimeEnvironments.list())
  await readRuntimeHostStatusSnapshots()
  toast.success(
    translate('auto.components.sidebar.AddWslHostDialogBody.added', '{{value0}} added.', {
      value0: args.distro
    })
  )
  return result
}
