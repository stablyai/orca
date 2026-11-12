// REPO-ACCESS-REFRESH: after "Add a GitHub repository…" the person grants access on GitHub and
// comes back. The list reads GitHub again when this window regains focus, and every few seconds
// while it has focus, until a repository shows up that wasn't listed before. That one is picked.
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  invalidateOrcaCloudGitHubRepositories,
  type OrcaCloudGitHubRepository
} from '@/lib/orca-cloud/use-orca-cloud-github-repositories'
import { installWindowVisibilityInterval } from '@/lib/window-activity/window-visibility-interval'

/** While focused, ask GitHub again this often (GitHub's install webhook can lag the redirect). */
export const GITHUB_HANDOFF_POLL_MS = 4_000
/** Stop waiting after this long: the person may have closed GitHub without granting anything. */
export const GITHUB_HANDOFF_WAIT_MS = 3 * 60_000

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
  waiting: boolean
  begin: () => void
  cancel: () => void
} {
  const [waiting, setWaiting] = useState(false)
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

  const begin = useCallback(() => {
    knownRef.current = reposRef.current ? names(reposRef.current) : null
    setWaiting(true)
  }, [])
  const cancel = useCallback(() => setWaiting(false), [])

  useEffect(() => {
    if (!waiting) {
      return
    }
    const reread = (): void => {
      invalidateOrcaCloudGitHubRepositories()
      onRereadRef.current()
    }
    // Away on GitHub, polling would only spend requests; coming back fires focus.
    const stopPolling = installWindowVisibilityInterval({
      run: () => {
        if (document.hasFocus()) {
          reread()
        }
      },
      // Not on install (the person is leaving for GitHub) or on becoming visible: focus covers the return.
      runOnVisible: () => {},
      intervalMs: GITHUB_HANDOFF_POLL_MS
    })
    const giveUp = window.setTimeout(cancel, GITHUB_HANDOFF_WAIT_MS)
    window.addEventListener('focus', reread)
    return () => {
      stopPolling()
      window.clearTimeout(giveUp)
      window.removeEventListener('focus', reread)
    }
  }, [cancel, waiting])

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
      setWaiting(false)
      onNewRef.current(added.fullName)
    }
  }, [repos, waiting])

  return { waiting, begin, cancel }
}
