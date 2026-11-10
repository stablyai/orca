// Can Orca Cloud clone this project's repository? Checked when Orca Cloud is picked (cloud-start D1),
// never after a build fails. "Not on GitHub" (D3) is known from the project's git remote with no
// network call; everything else comes from the control plane's GET /v1/github/repo-access (N2),
// cached 5 minutes. While a repository is waiting (an install in the browser, or an org owner's
// approval, D2), `poll` re-checks on the spec's cadence: every 2 s for 3 minutes, then every 10 s.
import { useCallback, useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store'
import { normalizeGitRemoteUrl } from '../../../../shared/git/remotes/git-remote-identity'
import type { HostedGithubRepoAccessResponse } from '../../../../shared/hosted-sandbox/hosted-github-wire'
import type { Repo } from '../../../../shared/repo-types'
import { cloudWorkspaceApi } from './orca-cloud-workspace-store'
import { useOrcaCloudIdentityKey } from './orca-cloud-identity'

export type OrcaCloudRepoAccessState =
  | 'ok'
  | 'needs-install'
  | 'pending-approval'
  | 'not-github'
  | 'unknown'

export type OrcaCloudRepoAccess = {
  state: OrcaCloudRepoAccessState
  /** GitHub's install page, preselecting this repository when its ids are known (N3). */
  installUrl?: string
  /** The control plane's raw answer: `public` and `granted` both read as `ok`. */
  access?: HostedGithubRepoAccessResponse['access']
  /** owner/repo for GitHub remotes, else the project's name. */
  repoName: string
  /** GitHub owner (org or user) login; D2 names it. */
  owner?: string
  /** https://github.com/<owner>/<repo>, or null when the project isn't on GitHub. */
  repoUrl: string | null
  /** True until the first answer for this repository arrives. */
  loading: boolean
}

export const REPO_ACCESS_CACHE_MS = 5 * 60_000
const FAST_POLL_MS = 2_000
const FAST_POLL_WINDOW_MS = 3 * 60_000
const SLOW_POLL_MS = 10_000

/** https://github.com/<owner>/<repo> from the project's remote; null when it isn't on GitHub. */
export function orcaCloudGitHubRepoUrl(
  repo: Pick<Repo, 'gitRemoteIdentity'> | undefined | null
): string | null {
  const remote = repo?.gitRemoteIdentity?.remoteUrl
  const normalized = remote ? normalizeGitRemoteUrl(remote) : null
  if (!normalized?.startsWith('github.com/')) {
    return null
  }
  const [owner, name] = normalized.slice('github.com/'.length).split('/')
  return owner && name ? `https://github.com/${owner}/${name.replace(/\.git$/, '')}` : null
}

export function repoAccessState(
  access: HostedGithubRepoAccessResponse['access'] | undefined
): OrcaCloudRepoAccessState {
  switch (access) {
    case 'public':
    case 'granted':
      return 'ok'
    case 'missing':
      return 'needs-install'
    case 'requested':
      return 'pending-approval'
    case undefined:
      return 'unknown'
  }
}

type CacheEntry = { at: number; value: HostedGithubRepoAccessResponse | null }
const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<HostedGithubRepoAccessResponse | null>>()

// Keyed by identity too: a sign-out or team switch must not reuse another identity's "Done".
function cacheKey(repoUrl: string, setupSessionId: string | undefined, identity = ''): string {
  return `${repoUrl.toLowerCase()}\0${setupSessionId ?? ''}\0${identity}`
}

/** Forget cached answers (sign-in changes, a finished install). */
export function invalidateOrcaCloudRepoAccess(repoUrl?: string): void {
  if (!repoUrl) {
    cache.clear()
    return
  }
  for (const key of cache.keys()) {
    if (key.startsWith(`${repoUrl.toLowerCase()}\0`)) {
      cache.delete(key)
    }
  }
}

/** One answer per repository at a time; null means "couldn't tell" (signed out, offline). */
export async function fetchOrcaCloudRepoAccess(
  repoUrl: string,
  options: { setupSessionId?: string; force?: boolean; now?: number; identity?: string } = {}
): Promise<HostedGithubRepoAccessResponse | null> {
  const key = cacheKey(repoUrl, options.setupSessionId, options.identity)
  const now = options.now ?? Date.now()
  const cached = cache.get(key)
  // Only real answers are cached: "couldn't tell" asks again next time.
  if (!options.force && cached?.value && now - cached.at < REPO_ACCESS_CACHE_MS) {
    return cached.value
  }
  const pending = inflight.get(key)
  if (pending) {
    return pending
  }
  const api = cloudWorkspaceApi()
  if (!api) {
    return null
  }
  const request = api
    .getRepoAccess({
      repoUrl,
      ...(options.setupSessionId ? { setupSessionId: options.setupSessionId } : {})
    })
    .then((result) => (result.ok ? result.value : null))
    .catch(() => null)
    .then((value) => {
      cache.set(key, { at: now, value })
      return value
    })
    .finally(() => inflight.delete(key))
  inflight.set(key, request)
  return request
}

export function useOrcaCloudRepoAccess(
  repoId: string | null | undefined,
  options: {
    /** Re-check while the repository is waiting on GitHub (an install or an owner's approval). */
    poll?: boolean
    setupSessionId?: string
    /** Skip the check (Orca Cloud isn't picked). */
    enabled?: boolean
    /** Fired once when a repository that was waiting becomes reachable (D2's "access granted"). */
    onGranted?: () => void
  } = {}
): OrcaCloudRepoAccess & { refresh: () => void; openInstall: () => Promise<boolean> } {
  const repo = useAppStore((s) =>
    repoId ? s.repos.find((entry) => entry.id === repoId) : undefined
  )
  const repoUrl = orcaCloudGitHubRepoUrl(repo)
  const enabled = options.enabled !== false && Boolean(repoUrl)
  const { poll = false, setupSessionId } = options
  const [answer, setAnswer] = useState<{
    key: string
    value: HostedGithubRepoAccessResponse | null
  } | null>(null)
  const [tick, setTick] = useState(0)
  const onGranted = useRef(options.onGranted)
  onGranted.current = options.onGranted
  const identity = useOrcaCloudIdentityKey()
  const key = repoUrl ? cacheKey(repoUrl, setupSessionId, identity) : ''
  const current = answer?.key === key ? answer.value : undefined
  const state = !repoUrl ? 'not-github' : repoAccessState(current?.access)
  const waiting = state === 'needs-install' || state === 'pending-approval'
  const waitingSince = useRef<number | null>(null)
  const wasWaiting = useRef(false)

  useEffect(() => {
    if (!enabled || !repoUrl) {
      return
    }
    let cancelled = false
    void fetchOrcaCloudRepoAccess(repoUrl, { setupSessionId, identity, force: tick > 0 }).then(
      (value) => {
        if (!cancelled) {
          setAnswer({ key, value })
        }
      }
    )
    return () => {
      cancelled = true
    }
  }, [enabled, repoUrl, setupSessionId, identity, key, tick])

  useEffect(() => {
    if (!enabled || !poll || !waiting) {
      waitingSince.current = null
      return
    }
    waitingSince.current ??= Date.now()
    const elapsed = Date.now() - waitingSince.current
    const timer = setTimeout(
      () => setTick((n) => n + 1),
      elapsed < FAST_POLL_WINDOW_MS ? FAST_POLL_MS : SLOW_POLL_MS
    )
    return () => clearTimeout(timer)
  }, [enabled, poll, waiting, current])

  useEffect(() => {
    if (waiting) {
      wasWaiting.current = true
    } else if (state === 'ok' && wasWaiting.current) {
      wasWaiting.current = false
      onGranted.current?.()
    }
  }, [state, waiting])

  const refresh = useCallback(() => setTick((n) => n + 1), [])
  const openInstall = useCallback(async () => {
    if (!repoUrl) {
      return false
    }
    // A fresh single-use link each time (the cached one may be past its 10 minutes).
    const result = await cloudWorkspaceApi()
      ?.connectGitHub({ repoUrl, ...(setupSessionId ? { setupSessionId } : {}) })
      .catch(() => null)
    return Boolean(result?.ok)
  }, [repoUrl, setupSessionId])

  return {
    state: enabled || !repoUrl ? state : 'unknown',
    ...(current?.installUrl ? { installUrl: current.installUrl } : {}),
    ...(current?.access ? { access: current.access } : {}),
    ...(current?.owner ? { owner: current.owner } : {}),
    repoName: repoUrl ? repoUrl.slice('https://github.com/'.length) : (repo?.displayName ?? ''),
    repoUrl,
    loading: enabled && current === undefined,
    refresh,
    openInstall
  }
}
