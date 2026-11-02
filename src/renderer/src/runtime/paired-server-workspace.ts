import { parseExecutionHostId } from '../../../shared/execution-host'
import { buildHostIdByWorktreeId } from '@/lib/workspace-session-host-persistence'
import type { HostIdByWorktreeId } from '@/lib/workspace-session-host-split'
import type { AppState } from '@/store/types'

/** Whether a paired server mirrors each workspace's layout, so main's frames draw none of it. */
export function pairedServerMirrors(state: AppState): (key: string) => boolean {
  let hostIdOf: HostIdByWorktreeId | null = null
  return (key) => {
    hostIdOf ??= buildHostIdByWorktreeId(state)
    return parseExecutionHostId(hostIdOf(key))?.kind === 'runtime'
  }
}
