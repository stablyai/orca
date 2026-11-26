// The picked host's MCP servers for Settings: its list and the servers found in its agents, re-read
// whenever any client changes them, plus one problems check per page visit.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { BotToolProblem } from '../../../../../shared/bot-tools'
import type { DiscoveredMcpServer } from '../../../../../shared/mcp-servers/mcp-servers'
import { onMcpServersChanged } from '@/lib/mcp-servers-changed-window-event'
import { getRuntimeTargetHostId } from '@/runtime/rpc/targets/runtime-client-target'
import {
  cancelMcpServerProblems,
  discoverMcpServers,
  readMcpServerList,
  readMcpServerProblems,
  type McpServerList
} from '@/runtime/mcp-servers/mcp-servers-client'
import { botToolErrorMessage } from '@/components/bots/bot-tools-client'

export type McpServersState = {
  list: McpServerList | null
  discovered: DiscoveredMcpServer[]
  problems: Record<string, BotToolProblem>
  error: string | null
  reload: () => void
}

/**
 * `withChecks`: also the servers found in the host's agents and one problems check, which starts the
 * servers; only the list page shows them.
 */
export function useMcpServers(target: RuntimeClientTarget, withChecks = false): McpServersState {
  const [list, setList] = useState<McpServerList | null>(null)
  const [discovered, setDiscovered] = useState<DiscoveredMcpServer[]>([])
  const [problems, setProblems] = useState<Record<string, BotToolProblem>>({})
  const [error, setError] = useState<string | null>(null)
  // Only the newest read lands: a slow one must not overwrite a later change.
  const generation = useRef(0)
  const host = useStableMcpTarget(target)
  const hostId = getRuntimeTargetHostId(host)

  const reload = useCallback(() => {
    const current = ++generation.current
    void Promise.all([
      readMcpServerList(host),
      withChecks ? discoverMcpServers(host).catch(() => []) : []
    ]).then(
      ([nextList, nextDiscovered]) => {
        if (generation.current === current) {
          setList(nextList)
          setDiscovered(nextDiscovered)
          setError(null)
        }
      },
      (caught: unknown) => {
        if (generation.current === current) {
          setError(botToolErrorMessage(caught))
        }
      }
    )
  }, [host, withChecks])

  useEffect(() => {
    reload()
    return onMcpServersChanged(reload, hostId)
  }, [hostId, reload])

  useEffect(() => {
    if (!withChecks) {
      return
    }
    let live = true
    void readMcpServerProblems(host).then(
      (found) => {
        if (live) {
          setProblems(found)
        }
      },
      // A check that can't run leaves the rows as the list says them.
      () => undefined
    )
    return () => {
      live = false
      cancelMcpServerProblems(host)
    }
  }, [host, withChecks])

  return { list, discovered, problems, error, reload }
}

/** One target object per host, so effects keyed by it run once per host, not once per render. */
export function useStableMcpTarget(target: RuntimeClientTarget): RuntimeClientTarget {
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  return useMemo(
    () => (environmentId === null ? { kind: 'local' } : { kind: 'environment', environmentId }),
    [environmentId]
  )
}
