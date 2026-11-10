import type * as React from 'react'
import type {
  AgentSessionMcpAction,
  AgentSessionMcpResult,
  AgentSessionMcpServer
} from '../agent-session-mcp'

export type AgentSessionMcpRequest = (
  operation: AgentSessionMcpAction
) => Promise<AgentSessionMcpResult>

export function createAgentSessionMcpHook({
  useCallback,
  useEffect,
  useRef,
  useState
}: Pick<typeof React, 'useCallback' | 'useEffect' | 'useRef' | 'useState'>) {
  return function useAgentSessionMcp(request: AgentSessionMcpRequest) {
    const [servers, setServers] = useState<AgentSessionMcpServer[] | null>(null)
    const [failure, setFailure] = useState<Exclude<AgentSessionMcpResult['status'], 'ok'> | null>(
      null
    )
    const [pending, setPending] = useState<AgentSessionMcpAction | null>(null)
    const busy = useRef(false)
    const generation = useRef(0)
    const run = useCallback(
      async (operation: AgentSessionMcpAction) => {
        if (busy.current) {
          return
        }
        busy.current = true
        const owner = generation.current
        setPending(operation)
        const reply = await request(operation).catch((): AgentSessionMcpResult => ({
          status: 'unavailable'
        }))
        if (generation.current !== owner) {
          return
        }
        if (reply.status === 'ok') {
          setServers(reply.servers)
          setFailure(null)
        } else {
          setFailure(reply.status)
        }
        setPending(null)
        busy.current = false
      },
      [request]
    )
    useEffect(() => {
      busy.current = false
      setServers(null)
      setFailure(null)
      void run({ action: 'status' })
      return () => {
        generation.current += 1
      }
    }, [run])
    return { servers, pending, failure, run }
  }
}
