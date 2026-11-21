import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'
import { getPairedWebClientEnvironmentId } from '@/app-shell/platform/paired-web-client-host'
import { selectExecutionHostDisplayLabel } from '@/runtime/hosts/display/execution-host-display-label'
import { useAppStore } from '@/store'
import {
  LOCAL_EXECUTION_HOST_ID,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host/execution-host'

/**
 * The paired server a bot runs on, by its name in Settings; null for this computer's own bots, and
 * in a paired web window, whose bots are all on its one server.
 */
export function useBotHostLabel(hostId: ExecutionHostId): string | null {
  return useAppStore((state) =>
    hostId === LOCAL_EXECUTION_HOST_ID || isPairedWebClientWindow()
      ? null
      : selectExecutionHostDisplayLabel(state, hostId)
  )
}
const NO_LABELS: ReadonlyMap<ExecutionHostId, string> = new Map()

/**
 * useBotHostLabel for a list: one store selector for the distinct paired servers, so a picker's
 * rows take their label as a prop instead of each subscribing. Hosts with no label are absent.
 */
export function useBotHostLabels(
  hostIds: readonly ExecutionHostId[]
): ReadonlyMap<ExecutionHostId, string> {
  const key = hostIds.join('\n')
  const remote = useMemo(
    () =>
      isPairedWebClientWindow()
        ? []
        : [...new Set(key.split('\n'))].filter(
            (hostId): hostId is ExecutionHostId =>
              hostId !== '' && hostId !== LOCAL_EXECUTION_HOST_ID
          ),
    [key]
  )
  const labels = useAppStore(
    useShallow((state) => remote.map((hostId) => selectExecutionHostDisplayLabel(state, hostId)))
  )
  return useMemo(
    () =>
      remote.length === 0
        ? NO_LABELS
        : new Map(remote.map((hostId, index) => [hostId, labels[index] ?? ''])),
    [remote, labels]
  )
}

/** The one server a paired web window is signed into. Null on the desktop, where host labels stay as they are. */
export function usePairedWebServerLabel(): string | null {
  return useAppStore((state) => {
    const environmentId = getPairedWebClientEnvironmentId(state)
    if (!environmentId) {
      return null
    }
    const label = selectExecutionHostDisplayLabel(
      state,
      toRuntimeExecutionHostId(environmentId)
    ).trim()
    return label || null
  })
}
