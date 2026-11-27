import { useEffect, useState } from 'react'
import type { BotToolProblem } from '../../../../../shared/bot-tools'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import {
  cancelMcpServerProblems,
  readMcpServerProblems
} from '@/runtime/mcp-servers/mcp-servers-client'
import { useStableMcpTarget } from '@/components/settings/mcp-servers/use-mcp-servers'

const NONE: Readonly<Record<string, BotToolProblem>> = {}

/**
 * While `checks` (an at-rest chat lists Orca servers), the host list's problems by server id, from
 * the same check Settings runs; one run per tray opening, ended when the tray closes.
 */
export function useOrcaMcpProblems(
  target: RuntimeClientTarget,
  agent: string,
  checks: boolean
): Readonly<Record<string, BotToolProblem>> {
  const host = useStableMcpTarget(target)
  const [problems, setProblems] = useState(NONE)
  useEffect(() => {
    if (!checks) {
      return undefined
    }
    let live = true
    void readMcpServerProblems(host, agent).then(
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
      cancelMcpServerProblems(host)
    }
  }, [agent, checks, host])
  return problems
}
