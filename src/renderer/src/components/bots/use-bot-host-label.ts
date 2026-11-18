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
