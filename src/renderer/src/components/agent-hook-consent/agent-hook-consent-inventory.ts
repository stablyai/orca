import type { AppState } from '@/store/types'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'

/**
 * Every agent CLI found on this computer: Windows/macOS/Linux itself plus each local WSL distro,
 * so an agent installed only inside WSL can still be asked about. Null until any list has loaded.
 */
export function readThisComputerDetectedAgents(
  state: Pick<AppState, 'localDetectedAgentIdsByContext'>
): TuiAgent[] | null {
  const lists = Object.values(state.localDetectedAgentIdsByContext ?? {}).filter(
    (list): list is TuiAgent[] => list !== null
  )
  return lists.length === 0 ? null : [...new Set(lists.flat())]
}
