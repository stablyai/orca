import { useCallback, useEffect, useState } from 'react'
import type { OrcaProfileOrgMembersListResult } from '../../../../../shared/orca-profiles'

type RosterState = { loading: boolean; result: OrcaProfileOrgMembersListResult | null }

function readRoster(orgId: string): Promise<OrcaProfileOrgMembersListResult> {
  return window.api.orcaProfiles
    .orgMembersList({ orgId })
    .catch((error: unknown): OrcaProfileOrgMembersListResult => ({
      status: 'failed',
      error: error instanceof Error ? error.message : String(error)
    }))
}

/** The org's live roster (members, pending invites, viewer role), re-read on `refresh()`. */
export function useOrgRoster(orgId: string): RosterState & { refresh: () => void } {
  const [state, setState] = useState<RosterState>({ loading: true, result: null })
  const [reloadKey, setReloadKey] = useState(0)
  const refresh = useCallback(() => setReloadKey((key) => key + 1), [])

  useEffect(() => {
    let disposed = false
    setState((previous) => ({ ...previous, loading: true }))
    void readRoster(orgId).then((result) => {
      if (!disposed) {
        setState({ loading: false, result })
      }
    })
    return () => {
      disposed = true
    }
  }, [orgId, reloadKey])

  return { ...state, refresh }
}
