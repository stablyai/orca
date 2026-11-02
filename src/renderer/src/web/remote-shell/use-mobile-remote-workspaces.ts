import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  RuntimeWorktreePsResult,
  RuntimeWorktreePsSummary
} from '../../../../shared/runtime-worktree-contracts'
import type {
  AgentSessionStatusEvent,
  AgentSessionStatusSummary
} from '../../../../shared/agent-session-wire'
import { buildMobileWorkspaces, type MobileWorkspaceGroup } from './mobile-remote-model'

type RuntimeResponse<TResult> = {
  ok: boolean
  result?: TResult
  error?: { message?: string }
}

async function callRuntime<TResult>(method: string, params?: unknown): Promise<TResult> {
  const response = (await window.api.runtime.call({ method, params })) as RuntimeResponse<TResult>
  if (!response.ok) {
    throw new Error(response.error?.message ?? `${method} failed`)
  }
  return response.result as TResult
}

export type MobileConnectionState = 'connecting' | 'connected' | 'offline'

export type MobileRemoteWorkspaces = {
  workspaces: MobileWorkspaceGroup[]
  sessions: Map<string, AgentSessionStatusSummary>
  connectionState: MobileConnectionState
  loading: boolean
  error: string | null
  refresh: () => void
}

/**
 * Join the desktop's worktree catalog with its structured-session status feed.
 *
 * `worktree.ps` is a snapshot, so it is polled for new/removed worktrees; the
 * status stream is live and is the only source of per-chat state.
 */
export function useMobileRemoteWorkspaces(): MobileRemoteWorkspaces {
  const [worktrees, setWorktrees] = useState<RuntimeWorktreePsSummary[]>([])
  const [sessions, setSessions] = useState<Map<string, AgentSessionStatusSummary>>(
    () => new Map()
  )
  const [connectionState, setConnectionState] = useState<MobileConnectionState>('connecting')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const refreshInFlight = useRef(false)
  const mounted = useRef(true)

  const loadWorktrees = useCallback(async (initial: boolean): Promise<void> => {
    if (refreshInFlight.current) {
      return
    }
    refreshInFlight.current = true
    if (initial) {
      setLoading(true)
    }
    try {
      const result = await callRuntime<RuntimeWorktreePsResult>('worktree.ps', { limit: 200 })
      if (!mounted.current) {
        return
      }
      setWorktrees(result.worktrees ?? [])
      setConnectionState('connected')
      setError(null)
    } catch (loadError) {
      if (!mounted.current) {
        return
      }
      setConnectionState('offline')
      setError(loadError instanceof Error ? loadError.message : String(loadError))
    } finally {
      refreshInFlight.current = false
      if (mounted.current) {
        setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    let cancelled = false
    let statusHandle: { unsubscribe: () => void } | null = null

    void loadWorktrees(true)

    const poll = window.setInterval(() => {
      void loadWorktrees(false)
    }, 15_000)

    void window.api.runtime
      .subscribe({ method: 'agentSession.subscribeStatus', params: {} }, (response) => {
        if (cancelled) {
          return
        }
        if (!response.ok) {
          setError(response.error?.message ?? 'Agent status stream failed')
          return
        }
        const event = response.result as AgentSessionStatusEvent
        if (event.type === 'snapshot') {
          setSessions(new Map(event.sessions.map((session) => [session.sessionId, session])))
          setConnectionState('connected')
        } else if (event.type === 'status') {
          setSessions((previous) => {
            const next = new Map(previous)
            next.set(event.session.sessionId, event.session)
            return next
          })
          setConnectionState('connected')
        } else if (event.type === 'end') {
          setConnectionState('offline')
        }
      })
      .then((handle) => {
        if (cancelled) {
          handle.unsubscribe()
        } else {
          statusHandle = handle
        }
      })
      .catch((subscribeError: unknown) => {
        if (!cancelled) {
          setError(
            subscribeError instanceof Error ? subscribeError.message : String(subscribeError)
          )
        }
      })

    return () => {
      cancelled = true
      mounted.current = false
      window.clearInterval(poll)
      statusHandle?.unsubscribe()
    }
  }, [loadWorktrees])

  const workspaces = useMemo(
    () => buildMobileWorkspaces({ worktrees, sessions: Array.from(sessions.values()) }),
    [worktrees, sessions]
  )

  const refresh = useCallback(() => {
    void loadWorktrees(false)
  }, [loadWorktrees])

  return { workspaces, sessions, connectionState, loading, error, refresh }
}
