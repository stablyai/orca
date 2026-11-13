// REPO-ACCESS-REFRESH: after "Add a GitHub repository…" the person grants access on GitHub and
// comes back. The list reads GitHub again when this window regains focus, and on a backing-off
// timer while it has focus, until a repository shows up that wasn't listed before. That one is
// picked. After a while with nothing new the wait stops and says so, with a way to check again.
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  invalidateOrcaCloudGitHubRepositories,
  type OrcaCloudGitHubRepository
} from '@/lib/orca-cloud/use-orca-cloud-github-repositories'

/**
 * Re-read delays while focused, then the last one repeats. Each re-read goes through the control
 * plane to GitHub's installation listing (no cache there), so it backs off: about ten reads in the
 * whole wait, and none while the window is away on GitHub.
 */
export const GITHUB_HANDOFF_POLL_DELAYS_MS = [4_000, 4_000, 8_000, 15_000, 30_000] as const
/** Coming back fires focus; a second focus right after doesn't read again. */
const FOCUS_REREAD_GAP_MS = 2_000
/** Stop waiting after this long: the person may have closed GitHub without granting anything. */
export const GITHUB_HANDOFF_WAIT_MS = 3 * 60_000

export type GitHubAccessHandoffPhase = 'idle' | 'waiting' | 'timed-out'

function names(repos: readonly OrcaCloudGitHubRepository[]): Set<string> {
  return new Set(repos.map((repo) => repo.fullName))
}

export function useGitHubAccessHandoff({
  repos,
  onReread,
  onNewRepository
}: {
  repos: readonly OrcaCloudGitHubRepository[] | null
  /** Read the list again (its cache was just dropped). */
  onReread: () => void
  onNewRepository: (fullName: string) => void
}): {
  phase: GitHubAccessHandoffPhase
  begin: () => void
  /** "Check again" after the wait ran out: reads once and waits again, from the same baseline. */
  checkAgain: () => void
  cancel: () => void
} {
  const [phase, setPhase] = useState<GitHubAccessHandoffPhase>('idle')
  // Listed before the handoff; null when the list hadn't loaded yet (the next answer is the baseline).
  const knownRef = useRef<ReadonlySet<string> | null>(null)
  const reposRef = useRef(repos)
  const onNewRef = useRef(onNewRepository)
  const onRereadRef = useRef(onReread)
  useEffect(() => {
    reposRef.current = repos
    onNewRef.current = onNewRepository
    onRereadRef.current = onReread
  })

  const reread = useCallback(() => {
    invalidateOrcaCloudGitHubRepositories()
    onRereadRef.current()
  }, [])
  const begin = useCallback(() => {
    knownRef.current = reposRef.current ? names(reposRef.current) : null
    setPhase('waiting')
  }, [])
  const checkAgain = useCallback(() => {
    reread()
    setPhase('waiting')
  }, [reread])
  const cancel = useCallback(() => setPhase('idle'), [])

  const waiting = phase === 'waiting'
  useEffect(() => {
    if (!waiting) {
      return
    }
    let lastRead = Date.now()
    const readIfHere = (): void => {
      // Away on GitHub, a read would only spend requests; coming back fires focus.
      if (document.visibilityState === 'visible' && document.hasFocus()) {
        lastRead = Date.now()
        reread()
      }
    }
    let attempt = 0
    let pollTimer = 0
    const schedule = (): void => {
      const delays = GITHUB_HANDOFF_POLL_DELAYS_MS
      const delay = delays[Math.min(attempt, delays.length - 1)]
      attempt += 1
      pollTimer = window.setTimeout(() => {
        readIfHere()
        schedule()
      }, delay)
    }
    schedule()
    const onFocus = (): void => {
      if (Date.now() - lastRead >= FOCUS_REREAD_GAP_MS) {
        lastRead = Date.now()
        reread()
      }
    }
    const giveUp = window.setTimeout(() => setPhase('timed-out'), GITHUB_HANDOFF_WAIT_MS)
    window.addEventListener('focus', onFocus)
    return () => {
      window.clearTimeout(pollTimer)
      window.clearTimeout(giveUp)
      window.removeEventListener('focus', onFocus)
    }
  }, [reread, waiting])

  // Each answer while waiting: the first one may only set the baseline; a new name is the grant.
  useEffect(() => {
    if (!waiting || !repos) {
      return
    }
    const known = knownRef.current
    if (!known) {
      knownRef.current = names(repos)
      return
    }
    const added = repos.find((repo) => !known.has(repo.fullName))
    if (added) {
      // The list is GitHub's answer to a re-read, not a prop to mirror: the wait ends with it.
      // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change
      setPhase('idle')
      onNewRef.current(added.fullName)
    }
  }, [repos, waiting])

  return { phase, begin, checkAgain, cancel }
}
