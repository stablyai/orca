import { useEffect } from 'react'
import { isWindowVisible } from '@/lib/window-visibility-interval'
import { subscribeRuntimeHostContactRegained } from '@/runtime/runtime-host-contact-regained'
import { parseExecutionHostId } from '../../../../shared/execution-host'

/** A status read before the runtime host answered (a relaunch) came back empty; read again once it does. */
export function useRefreshOnHostContact(
  executionHostId: string | null | undefined,
  scheduler: { readonly current: { refreshNow: () => void } | null },
  canFetch: { readonly current: boolean }
): void {
  const host = parseExecutionHostId(executionHostId)
  const environmentId = host?.kind === 'runtime' ? host.environmentId : null
  useEffect(() => {
    if (!environmentId) {
      return
    }
    return subscribeRuntimeHostContactRegained(environmentId, () => {
      if (canFetch.current && isWindowVisible()) {
        scheduler.current?.refreshNow()
      }
    })
  }, [environmentId, scheduler, canFetch])
}
