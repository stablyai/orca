import { parseExecutionHostId } from '../../../shared/execution-host'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import type { GitHubViewer } from '../../../shared/types'
import { useEffect, useMemo, useRef, useState } from 'react'
import { callRuntimeRpc } from '../runtime/runtime-rpc-client'

export type GitHubViewerLoginScope = {
  repoId: string
  repoPath: string
  sourceContext: TaskSourceContext | null
}

const inFlight = new Map<string, Promise<string | null>>()

function githubHost(scope: GitHubViewerLoginScope): string | undefined {
  const identity = scope.sourceContext?.providerIdentity
  if (identity?.provider !== 'github') {
    return undefined
  }
  return identity.host?.trim() || 'github.com'
}

function getGitHubViewerLoginRequestKey(scopes: readonly GitHubViewerLoginScope[]): string {
  return scopes
    .map((scope) => {
      const context = scope.sourceContext
      return [
        context?.hostId ?? 'local',
        context?.repoId ?? scope.repoId,
        scope.repoPath,
        githubHost(scope) ?? ''
      ].join('\0')
    })
    .sort()
    .join('\u0001')
}

async function loadViewer(
  scope: GitHubViewerLoginScope,
  force: boolean
): Promise<GitHubViewer | null> {
  const host = githubHost(scope)
  const parsedHost = parseExecutionHostId(scope.sourceContext?.hostId)
  if (parsedHost?.kind === 'runtime') {
    const repoId = scope.sourceContext?.repoId ?? scope.repoId
    return callRuntimeRpc<GitHubViewer | null>(
      { kind: 'environment', environmentId: parsedHost.environmentId },
      'github.viewer',
      {
        repo: `id:${repoId}`,
        ...(host ? { host } : {}),
        ...(force ? { force: true } : {})
      },
      { timeoutMs: 15_000 }
    )
  }
  return window.api.gh.viewer({
    repoPath: scope.repoPath,
    repoId: scope.repoId,
    sourceContext: scope.sourceContext,
    ...(force ? { force: true } : {})
  })
}

async function queryGitHubViewerLogin(
  scopes: readonly GitHubViewerLoginScope[],
  force: boolean
): Promise<string | null> {
  if (scopes.length === 0) {
    return null
  }
  const viewers = await Promise.all(
    scopes.map((scope) => loadViewer(scope, force).catch(() => null))
  )
  const logins = viewers.flatMap((viewer) => {
    const login = viewer?.login.trim()
    return login ? [login] : []
  })
  if (logins.length !== scopes.length) {
    return null
  }
  const normalized = new Set(logins.map((login) => login.toLowerCase()))
  return normalized.size === 1 ? (logins[0] ?? null) : null
}

export function loadGitHubViewerLogin(
  scopes: readonly GitHubViewerLoginScope[],
  force = false
): Promise<string | null> {
  const key = getGitHubViewerLoginRequestKey(scopes)
  const pending = inFlight.get(key)
  if (pending) {
    return pending
  }
  const request = queryGitHubViewerLogin(scopes, force)
  inFlight.set(key, request)
  void request.finally(() => {
    if (inFlight.get(key) === request) {
      inFlight.delete(key)
    }
  })
  return request
}

export function useGitHubViewerLogin(
  enabled: boolean,
  scopes: readonly GitHubViewerLoginScope[],
  refreshKey: number
): string | null {
  const requestKey = useMemo(() => getGitHubViewerLoginRequestKey(scopes), [scopes])
  const previousRefreshKey = useRef(refreshKey)
  const [state, setState] = useState<{ requestKey: string; login: string | null }>({
    requestKey: '',
    login: null
  })
  useEffect(() => {
    if (!enabled) {
      return
    }
    let stale = false
    const refresh = (force: boolean): void => {
      void loadGitHubViewerLogin(scopes, force).then((login) => {
        if (!stale) {
          setState((current) =>
            current.requestKey === requestKey && current.login === login
              ? current
              : { requestKey, login }
          )
        }
      })
    }
    const refreshWhenVisible = (): void => {
      if (document.visibilityState === 'visible') {
        refresh(true)
      }
    }
    const force = previousRefreshKey.current !== refreshKey
    previousRefreshKey.current = refreshKey
    refresh(force)
    document.addEventListener('visibilitychange', refreshWhenVisible)
    return () => {
      stale = true
      document.removeEventListener('visibilitychange', refreshWhenVisible)
    }
  }, [enabled, refreshKey, requestKey, scopes])
  return enabled && state.requestKey === requestKey ? state.login : null
}
