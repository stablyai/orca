// CLONE-ACCESS-ERROR: a cloud create whose clone GitHub refused. The card asks GitHub whether Orca
// can reach the repository, sends the person to the Orca GitHub App's install page for its owner
// (repository preselected), and once access shows up starts the create again on its own. Someone
// who can't install (GitHub turns their install into a request for an owner) is told who to ask.
import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { openOrcaGitHubAppInstall } from '@/lib/orca-cloud/cloud-setup-notice-actions'
import { cloudWorkspaceApi } from '@/lib/orca-cloud/orca-cloud-workspace-store'
import { fetchOrcaCloudRepoAccess } from '@/lib/orca-cloud/use-orca-cloud-repo-access'

/**
 * `checking`: asking GitHub. `missing`: the App doesn't reach it (Give Orca access). `waiting`:
 * back from GitHub's page, re-checking. `requested`: an owner must approve (Ask an owner).
 * `reachable`: Orca can reach it, so the clone failed for another reason (Try again).
 */
export type CloneAccessPhase = 'checking' | 'missing' | 'waiting' | 'requested' | 'reachable'

/** Re-check delays while focused after Give Orca access (as REPO-ACCESS-REFRESH backs off). */
export const CLONE_ACCESS_POLL_DELAYS_MS = [4_000, 4_000, 8_000, 15_000, 30_000] as const
/** How long "Copied" stays on the request button. */
export const COPIED_MS = 1_500
/** Stop waiting after this long: the button comes back. */
export const CLONE_ACCESS_WAIT_MS = 3 * 60_000

export function githubRepoUrlFor(repoName: string): string | null {
  return /^[\w.-]+\/[\w.-]+$/.test(repoName) ? `https://github.com/${repoName}` : null
}

function phaseFor(access: string | undefined): CloneAccessPhase {
  if (access === 'granted' || access === 'public') {
    return 'reachable'
  }
  return access === 'requested' ? 'requested' : 'missing'
}

export function useCloneAccessHandoff({
  repoName,
  enabled,
  onRetry
}: {
  /** owner/repo. */
  repoName: string
  /** Only for an Orca Cloud clone GitHub refused. */
  enabled: boolean
  /** Starts the create again (access arrived while waiting). */
  onRetry: () => void
}): {
  phase: CloneAccessPhase
  giveAccess: () => void
  copyRequest: () => void
  /** The request was just copied: the button reads Copied for a moment (like the W-number chip). */
  copied: boolean
} {
  const repoUrl = githubRepoUrlFor(repoName)
  const [phase, setPhase] = useState<CloneAccessPhase>('checking')
  const onRetryRef = useRef(onRetry)
  useEffect(() => {
    onRetryRef.current = onRetry
  })

  /** What GitHub says about Orca's access now, as a phase. */
  const check = useCallback(async (): Promise<CloneAccessPhase> => {
    if (!repoUrl) {
      return 'missing'
    }
    return phaseFor((await fetchOrcaCloudRepoAccess(repoUrl, { force: true }))?.access)
  }, [repoUrl])

  useEffect(() => {
    if (!enabled) {
      return
    }
    let cancelled = false
    void check().then((next) => {
      if (!cancelled) {
        setPhase(next)
      }
    })
    return () => {
      cancelled = true
    }
  }, [check, enabled])

  // After Give Orca access (or while an owner is asked): re-check on focus, and on a backing-off
  // timer while focused; an owner's approval also lands here and the create starts again.
  const watching = enabled && (phase === 'waiting' || phase === 'requested')
  useEffect(() => {
    if (!watching) {
      return
    }
    let attempt = 0
    let timer = 0
    // An answer that lands after the wait ended (or moved on) changes nothing.
    let cancelled = false
    const recheck = (): void => {
      if (cancelled || document.visibilityState !== 'visible' || !document.hasFocus()) {
        return
      }
      void check().then((next) => {
        if (cancelled) {
          return
        }
        if (next === 'reachable') {
          // One retry per handoff: the card closes as the create starts again.
          cancelled = true
          onRetryRef.current()
          return
        }
        // Still nothing: keep waiting (or asking) rather than flip back to the button.
        setPhase(next === 'missing' ? phase : next)
      })
    }

    const schedule = (): void => {
      const delays = CLONE_ACCESS_POLL_DELAYS_MS
      timer = window.setTimeout(
        () => {
          recheck()
          schedule()
        },
        delays[Math.min(attempt++, delays.length - 1)]
      )
    }
    schedule()
    window.addEventListener('focus', recheck)
    const giveUp =
      phase === 'waiting'
        ? window.setTimeout(() => {
            // Before the state change: a check still in flight must not undo it.
            cancelled = true
            setPhase('missing')
          }, CLONE_ACCESS_WAIT_MS)
        : undefined
    return () => {
      cancelled = true
      window.clearTimeout(timer)
      window.clearTimeout(giveUp)
      window.removeEventListener('focus', recheck)
    }
  }, [check, phase, watching])

  const giveAccess = useCallback(() => {
    if (!repoUrl) {
      return
    }
    void openOrcaGitHubAppInstall(repoUrl).then((opened) => {
      if (opened) {
        setPhase('waiting')
      }
    })
  }, [repoUrl])

  const [copied, setCopied] = useState(false)
  const copiedTimer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(copiedTimer.current), [])
  const copyRequest = useCallback(() => {
    void copyOwnerRequest(repoName, repoUrl).then((ok) => {
      if (ok) {
        setCopied(true)
        window.clearTimeout(copiedTimer.current)
        copiedTimer.current = window.setTimeout(() => setCopied(false), COPIED_MS)
      }
    })
  }, [repoName, repoUrl])

  return { phase, giveAccess, copyRequest, copied }
}

/** A message for an owner of the repository's org, with the install link that preselects it. */
export async function copyOwnerRequest(repoName: string, repoUrl: string | null): Promise<boolean> {
  const link = repoUrl
    ? await cloudWorkspaceApi()
        ?.gitHubInstallLink({ repoUrl })
        .then((result) => (result.ok ? result.value : null))
        .catch(() => null)
    : null
  const message = translate(
    'worktreeCreation.cloneAccess.requestMessage',
    'Could you give the Orca GitHub App access to {{repo}}? Orca Cloud needs it to start workspaces from this repository.',
    { repo: repoName }
  )
  try {
    await window.api.ui.writeClipboardText(link ? `${message}\n${link}` : message)
    return true
  } catch {
    toast.error(translate('worktreeCreation.cloneAccess.requestCopyFailed', 'Couldn’t copy it.'))
    return false
  }
}
