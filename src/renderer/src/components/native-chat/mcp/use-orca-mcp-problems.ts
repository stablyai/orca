import { useEffect, useState } from 'react'
import type { BotToolProblem } from '../../../../../shared/bot-tools'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { newMcpProblemsRequestId } from '../../../../../shared/agent-session/view/agent-session-mcp-server-presentation'
import {
  cancelMcpServerProblems,
  readMcpServerProblems
} from '@/runtime/mcp-servers/mcp-servers-client'
import { useStableMcpTarget } from '@/components/settings/mcp-servers/use-mcp-servers'

const NONE: Readonly<Record<string, BotToolProblem>> = {}

/**
 * The problems of an at-rest chat's Orca servers (`ids`, a comma-joined key; none when empty) by
 * server id, from the check Settings runs over just those; one run per tray opening, ended when the
 * tray closes or the agent starts.
 */
export function useOrcaMcpProblems(
  target: RuntimeClientTarget,
  agent: string,
  ids: string
): Readonly<Record<string, BotToolProblem>> {
  const host = useStableMcpTarget(target)
  const [problems, setProblems] = useState(NONE)
  useEffect(() => {
    if (!ids) {
      return undefined
    }
    let live = true
    const requestId = newMcpProblemsRequestId()
    void readMcpServerProblems(host, { agent, ids: ids.split(','), requestId }).then(
      (found) => {
        if (live) {
          setProblems(found)
        }
      },
      // A check that can't run leaves the rows as the host listed them.
      () => undefined
    )
    return () => {
      live = false
      cancelMcpServerProblems(host, requestId)
    }
  }, [agent, ids, host])
  return problems
}
