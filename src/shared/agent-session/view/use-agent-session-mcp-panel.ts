import type * as React from 'react'
import type {
  AgentSessionMcpOperation,
  AgentSessionMcpResult,
  AgentSessionMcpServer,
  AgentSessionMcpSignIn
} from '../options/protocol/agent-session-mcp'

export type AgentSessionMcpRequest = (
  operation: AgentSessionMcpOperation
) => Promise<AgentSessionMcpResult>

export type AgentSessionMcpPanelState = {
  /** null while the first read is in flight. */
  result:
    | Exclude<AgentSessionMcpResult, { status: 'ok' | 'not-running' }>
    | { status: 'ok' | 'not-running' }
    | null
  servers: readonly AgentSessionMcpServer[]
  /** The action in flight, one at a time. */
  pending: Exclude<AgentSessionMcpOperation, { action: 'status' }> | null
  signIn: AgentSessionMcpSignIn | null
  /** The last action's refusal, as the agent worded it; null message means no detail. */
  failure: AgentSessionMcpFailure | null
}

export type AgentSessionMcpFailure = {
  server: string
  message: string | null
  /** A reconnect that left the server failed: the row says so even when the reason is unchanged. */
  stillFailing?: true
}

/** A reconnect the agent ran that left the server failed, or that it refused with a reason. */
function reconnectStillFailing(
  operation: AgentSessionMcpOperation,
  reply: AgentSessionMcpResult
): AgentSessionMcpFailure | null {
  if (operation.action !== 'reconnect') {
    return null
  }
  if (reply.status === 'failed') {
    return reply.message === null
      ? null
      : { server: operation.server, message: reply.message, stillFailing: true }
  }
  const row =
    reply.status === 'ok'
      ? reply.servers.find((server) => server.name === operation.server)
      : undefined
  // The status line gives the reason, which may change while the note stands.
  return row?.status === 'failed'
    ? { server: operation.server, message: null, stillFailing: true }
    : null
}

const POLL_MS = 2_000
const MAX_POLL_MS = 15_000
// Agents close their sign-in callback after five minutes.
const SIGN_IN_WINDOW_MS = 5 * 60_000

/** State for the `/mcp` panel; `openUrl` opens a sign-in page in the device's browser, and a new
 *  `refreshKey` (the agent starting or stopping, `/mcp` run again) re-reads the servers. */
export function createAgentSessionMcpPanelHook({
  useCallback,
  useEffect,
  useRef,
  useState
}: Pick<typeof React, 'useCallback' | 'useEffect' | 'useRef' | 'useState'>) {
  return function useAgentSessionMcpPanel(
    request: AgentSessionMcpRequest,
    openUrl: (url: string) => void,
    refreshKey?: unknown,
    /** `reconnectFeedback`: a reconnect that leaves the server failed says so (hosts with MCP servers on). */
    { reconnectFeedback = false }: { reconnectFeedback?: boolean } = {}
  ) {
    const [state, setState] = useState<AgentSessionMcpPanelState>({
      result: null,
      servers: [],
      pending: null,
      signIn: null,
      failure: null
    })
    const busy = useRef(false)
    const reading = useRef(false)
    // A read asked for mid-read may follow a change the one in flight missed.
    const readAgain = useRef(false)
    // Bumped as each action starts and ends, so a read that overlapped one can't show older state.
    const actions = useRef(0)
    const mounted = useRef(true)
    const feedback = useRef(reconnectFeedback)
    feedback.current = reconnectFeedback
    const stillFailing = (operation: AgentSessionMcpOperation, reply: AgentSessionMcpResult) =>
      feedback.current ? reconnectStillFailing(operation, reply) : null
    useEffect(() => {
      mounted.current = true
      return () => {
        mounted.current = false
      }
    }, [])

    const apply = useCallback(
      (reply: AgentSessionMcpResult, operation: AgentSessionMcpOperation) => {
        if (!mounted.current) {
          return
        }
        setState((current) => {
          // A status read lands beside an action still in flight; only the action's reply ends it.
          const pending = operation.action === 'status' ? current.pending : null
          if (reply.status !== 'ok') {
            const server = 'server' in operation ? operation.server : null
            // A failed sign-in poll keeps the list and the sign-in it watches.
            if (!server && reply.status === 'failed' && current.result?.status === 'ok') {
              return current
            }
            // A failed action keeps the list; a failed first read replaces it. An agent at rest
            // lists what its host knows its next start gets.
            return server && reply.status === 'failed'
              ? {
                  ...current,
                  pending,
                  failure: stillFailing(operation, reply) ?? {
                    server,
                    message: reply.message
                  }
                }
              : {
                  ...current,
                  pending,
                  result: reply.status === 'not-running' ? { status: 'not-running' } : reply,
                  servers: (reply.status === 'not-running' && reply.servers) || [],
                  signIn: null
                }
          }
          const signIn =
            reply.signIn ??
            (current.signIn &&
            reply.servers.some(
              (entry) => entry.name === current.signIn?.server && entry.status !== 'connected'
            )
              ? current.signIn
              : null)
          return {
            result: { status: 'ok' },
            servers: reply.servers,
            pending,
            signIn,
            failure:
              operation.action === 'status' ? current.failure : stillFailing(operation, reply)
          }
        })
      },
      []
    )

    const read = useCallback(async () => {
      if (reading.current) {
        readAgain.current = true
        return
      }
      reading.current = true
      do {
        readAgain.current = false
        const operation = { action: 'status' } as const
        const started = actions.current
        const reply = await request(operation).catch((): AgentSessionMcpResult => ({
          status: 'failed',
          message: null
        }))
        if (actions.current === started) {
          apply(reply, operation)
        }
      } while (readAgain.current && mounted.current)
      reading.current = false
    }, [apply, request])

    const run = useCallback(
      async (operation: Exclude<AgentSessionMcpOperation, { action: 'status' }>) => {
        if (busy.current) {
          return
        }
        busy.current = true
        actions.current += 1
        setState((current) => ({ ...current, pending: operation, failure: null }))
        const reply = await request(operation).catch((): AgentSessionMcpResult => ({
          status: 'failed',
          message: null
        }))
        busy.current = false
        actions.current += 1
        // A panel closed while the request ran must not open a browser.
        if (reply.status === 'ok' && reply.signIn && mounted.current) {
          openUrl(reply.signIn.url)
        }
        apply(reply, operation)
        // Agents refuse an action that half-happened (a server enabled but needing sign-in); show
        // where it ended up.
        if (reply.status === 'failed') {
          void read()
        }
      },
      [apply, openUrl, read, request]
    )

    const dismissSignIn = useCallback(() => {
      setState((current) => ({ ...current, signIn: null, failure: null }))
    }, [])

    useEffect(() => {
      void read()
    }, [read, refreshKey])

    // Nothing reports when an agent finishes a callback sign-in or a server settles from
    // connecting; re-read with backoff, and stop at the agents' own five-minute window.
    const watching = state.signIn?.finish === 'callback' ? state.signIn : null
    const connecting = state.servers.some((server) => server.status === 'pending')
    useEffect(() => {
      if (!watching && !connecting) {
        return
      }
      const started = Date.now()
      let delay = POLL_MS
      let timer: ReturnType<typeof setTimeout> | undefined
      const tick = (): void => {
        if (Date.now() - started > SIGN_IN_WINDOW_MS) {
          setState((current) =>
            watching && current.signIn === watching ? { ...current, signIn: null } : current
          )
          return
        }
        if (!busy.current) {
          void read()
        }
        delay = Math.min(delay * 1.5, MAX_POLL_MS)
        timer = setTimeout(tick, delay)
      }
      timer = setTimeout(tick, delay)
      return () => clearTimeout(timer)
    }, [connecting, read, watching])

    return { ...state, run, retry: read, dismissSignIn }
  }
}
