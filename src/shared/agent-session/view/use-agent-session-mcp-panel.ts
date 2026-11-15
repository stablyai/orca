import type * as React from 'react'
import type {
  AgentSessionMcpOperation,
  AgentSessionMcpResult,
  AgentSessionMcpServer,
  AgentSessionMcpSignIn
} from '../agent-session-mcp'

export type AgentSessionMcpRequest = (
  operation: AgentSessionMcpOperation
) => Promise<AgentSessionMcpResult>

export type AgentSessionMcpPanelState = {
  /** null while the first read is in flight. */
  result: Exclude<AgentSessionMcpResult, { status: 'ok' }> | { status: 'ok' } | null
  servers: readonly AgentSessionMcpServer[]
  /** The action in flight, one at a time. */
  pending: Exclude<AgentSessionMcpOperation, { action: 'status' }> | null
  signIn: AgentSessionMcpSignIn | null
  /** The last action's refusal, as the agent worded it; null message means no detail. */
  failure: { server: string; message: string | null } | null
}

const POLL_MS = 2_000
const MAX_POLL_MS = 15_000
// Agents close their sign-in callback after five minutes.
const SIGN_IN_WINDOW_MS = 5 * 60_000

/** State for the `/mcp` panel; `openUrl` opens a sign-in page in the device's browser. */
export function createAgentSessionMcpPanelHook({
  useCallback,
  useEffect,
  useRef,
  useState
}: Pick<typeof React, 'useCallback' | 'useEffect' | 'useRef' | 'useState'>) {
  return function useAgentSessionMcpPanel(
    request: AgentSessionMcpRequest,
    openUrl: (url: string) => void
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
    // Bumped as each action starts and ends, so a read that overlapped one can't show older state.
    const actions = useRef(0)
    const mounted = useRef(true)
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
            // A failed action keeps the list; a failed first read replaces it.
            return server && reply.status === 'failed'
              ? { ...current, pending, failure: { server, message: reply.message } }
              : { ...current, pending, result: reply, servers: [], signIn: null }
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
            failure: operation.action === 'status' ? current.failure : null
          }
        })
      },
      []
    )

    const read = useCallback(async () => {
      if (reading.current) {
        return
      }
      reading.current = true
      const operation = { action: 'status' } as const
      const started = actions.current
      const reply = await request(operation).catch((): AgentSessionMcpResult => ({
        status: 'failed',
        message: null
      }))
      reading.current = false
      if (actions.current === started) {
        apply(reply, operation)
      }
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
    }, [read])

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
