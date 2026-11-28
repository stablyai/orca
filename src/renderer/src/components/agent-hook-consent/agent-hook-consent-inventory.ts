import type { AppState } from '@/store/types'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'

/**
 * Every agent CLI found on this computer: Windows/macOS/Linux itself plus each local WSL distro,
 * so an agent installed only inside WSL can still be asked about. Null until any list has loaded.
 */
let cachedSource: AppState['localDetectedAgentIdsByContext'] | undefined
let cachedAgents: TuiAgent[] | null = null

export function readThisComputerDetectedAgents(
  state: Pick<AppState, 'localDetectedAgentIdsByContext'>
): TuiAgent[] | null {
  // Why cache by identity: the store replaces this record only when an inventory loads.
  if (state.localDetectedAgentIdsByContext === cachedSource) {
    return cachedAgents
  }
  cachedSource = state.localDetectedAgentIdsByContext
  const lists = Object.values(state.localDetectedAgentIdsByContext ?? {}).filter(
    (list): list is TuiAgent[] => list !== null
  )
  cachedAgents = lists.length === 0 ? null : [...new Set(lists.flat())]
  return cachedAgents
}
