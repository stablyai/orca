import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { isPairedWebClientWindow } from '@/app-shell/chrome/desktop-window-chrome'
import { selectExecutionHostDisplayLabel } from '@/runtime/hosts/display/execution-host-display-label'
import { useAppStore } from '@/store'
import {
  LOCAL_EXECUTION_HOST_ID,
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
