import { useMemo, useState } from 'react'
import {
  getOptInOnlyExperimentVisibility,
  type OptInOnlyExperimentVisibility
} from './experimental-search'

/** Which opt-in-only experiment rows one Settings visit shows, in the pane and in Settings search.
 *  A row that was on at any point in the visit stays until Settings closes, so switching it off,
 *  leaving the section or searching never strands the user mid-visit. The next visit shows it
 *  only if it is still on. */
export function useOptInOnlyExperimentRows(
  settings: Parameters<typeof getOptInOnlyExperimentVisibility>[0],
  hiddenExperimentalUnlocked: boolean
): OptInOnlyExperimentVisibility {
  const live = getOptInOnlyExperimentVisibility(settings)
  const [seenOn, setSeenOn] = useState(live)
  // Why during render: settings can load after Settings mounts, and a later switch-on must latch too.
  if (
    (live.agentDashboard && !seenOn.agentDashboard) ||
    (live.terminalAttention && !seenOn.terminalAttention)
  ) {
    setSeenOn({
      agentDashboard: seenOn.agentDashboard || live.agentDashboard,
      terminalAttention: seenOn.terminalAttention || live.terminalAttention
    })
  }
  const agentDashboard = hiddenExperimentalUnlocked || seenOn.agentDashboard || live.agentDashboard
  const terminalAttention =
    hiddenExperimentalUnlocked || seenOn.terminalAttention || live.terminalAttention
  return useMemo(() => ({ agentDashboard, terminalAttention }), [agentDashboard, terminalAttention])
}
