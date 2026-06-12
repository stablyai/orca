import { useState } from 'react'
import { useMountedRef } from '@/hooks/useMountedRef'
import { getLocalPreflightContext, localPreflightContextKey } from '@/lib/local-preflight-context'
import { useAppStore } from '@/store'
import {
  getPreflightIntegrationStatuses,
  type PreflightIntegrationStatuses,
  type PreflightRefreshProvider
} from './integrations-pane-status'

type CliStatus = {
  installed?: boolean
  authenticated?: boolean
}

export type CliProviderCardState =
  | 'checking'
  | 'connected'
  | 'not-installed'
  | 'not-authenticated'
  | 'unavailable'

export function deriveCliProviderCardState(input: {
  cliStatus?: CliStatus
  preflightStatusAvailable: boolean
  preflightStatusChecked: boolean
  preflightStatusCurrent: boolean
  preflightStatusError: string | null
  preflightStatusLoading: boolean
}): CliProviderCardState {
  if (
    input.preflightStatusLoading ||
    !input.preflightStatusChecked ||
    !input.preflightStatusCurrent
  ) {
    return 'checking'
  }
  if (input.preflightStatusError !== null || !input.preflightStatusAvailable || !input.cliStatus) {
    return 'unavailable'
  }
  if (!input.cliStatus.installed) {
    return 'not-installed'
  }
  return input.cliStatus.authenticated ? 'connected' : 'not-authenticated'
}

export type PreflightCardStatuses = {
  statuses: PreflightIntegrationStatuses
  unavailable: boolean
  refresh: () => void
}

export function usePreflightCardStatuses(
  provider: PreflightRefreshProvider
): PreflightCardStatuses {
  const preflightStatus = useAppStore((s) => s.preflightStatus)
  const preflightStatusChecked = useAppStore((s) => s.preflightStatusChecked)
  const preflightStatusContextKey = useAppStore((s) => s.preflightStatusContextKey)
  const preflightStatusError = useAppStore((s) => s.preflightStatusError)
  const preflightStatusLoading = useAppStore((s) => s.preflightStatusLoading)
  const refreshPreflightStatus = useAppStore((s) => s.refreshPreflightStatus)
  const expectedPreflightContextKey = useAppStore((s) =>
    localPreflightContextKey(getLocalPreflightContext(s))
  )
  const mountedRef = useMountedRef()
  const [refreshing, setRefreshing] = useState(false)
  const refreshingProviders: ReadonlySet<PreflightRefreshProvider> = refreshing
    ? new Set<PreflightRefreshProvider>([provider])
    : new Set<PreflightRefreshProvider>()
  const preflightCurrent = preflightStatusContextKey === expectedPreflightContextKey
  const unavailable =
    !preflightStatusLoading &&
    preflightStatusChecked &&
    preflightCurrent &&
    preflightStatusError !== null
  const statusInput =
    !preflightStatusLoading && preflightStatusChecked && preflightCurrent && !unavailable
      ? preflightStatus
      : null

  const refresh = (): void => {
    setRefreshing(true)
    void refreshPreflightStatus({ force: true }).finally(() => {
      if (mountedRef.current) {
        setRefreshing(false)
      }
    })
  }

  return {
    statuses: getPreflightIntegrationStatuses(statusInput, refreshingProviders),
    unavailable,
    refresh
  }
}
