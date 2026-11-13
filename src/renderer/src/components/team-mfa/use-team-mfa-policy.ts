import { useCallback, useEffect, useRef, useState } from 'react'
import type { OrcaTeamMfaPolicy } from '../../../../shared/orca-team-mfa-policy'

export type TeamMfaPolicyState = {
  /** Null until a read answers, when signed out of a team, or when the server has no policy API. */
  policy: OrcaTeamMfaPolicy | null
  /** A read is running. */
  checking: boolean
  /** Re-reads now; resolves with what the server said (null when it could not be read). */
  refresh: () => Promise<OrcaTeamMfaPolicy | null>
}

/**
 * The active team's "require MFA" policy and the person's own state in it. Read when the team
 * changes and when the window regains focus: the person sets MFA up in the browser and comes back.
 * A failed read keeps the last answer, so a flaky network neither hides the banner nor blocks.
 */
export function useTeamMfaPolicy(orgId: string | null): TeamMfaPolicyState {
  const [policy, setPolicy] = useState<OrcaTeamMfaPolicy | null>(null)
  const [checking, setChecking] = useState(false)
  // Answers for a team the person has since switched away from are dropped.
  const current = useRef(orgId)
  current.current = orgId

  const refresh = useCallback(async (): Promise<OrcaTeamMfaPolicy | null> => {
    if (!orgId) {
      return null
    }
    setChecking(true)
    let result: Awaited<ReturnType<typeof window.api.orcaProfiles.teamMfaPolicy>> | null
    try {
      result = (await window.api.orcaProfiles.teamMfaPolicy({ orgId })) ?? null
    } catch {
      result = null
    }
    if (current.current !== orgId) {
      return null
    }
    setChecking(false)
    if (result?.status !== 'ok') {
      return null
    }
    const { status: _status, ...next } = result
    setPolicy(next)
    return next
  }, [orgId])

  useEffect(() => {
    setPolicy(null)
    setChecking(false)
    if (!orgId) {
      return
    }
    void refresh()
    const onFocus = (): void => void refresh()
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') {
        void refresh()
      }
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [orgId, refresh])

  return { policy, checking, refresh }
}
