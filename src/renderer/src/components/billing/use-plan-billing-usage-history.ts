import { useCallback, useEffect, useRef, useState } from 'react'
import type { OrcaBillingUsageHistory } from '../../../../shared/orca-billing'
import type { CloudWorkspace } from '../../../../shared/cloud-workspaces/cloud-workspaces-wire'
import { useTranslate } from '@/i18n/use-translate'
import { cloudWorkspaceTitle } from '../cloud-workspaces/open-cloud-workspace'
import { useOrgRoster } from './team/use-org-roster'
import { usageWorkspaceNames, type UsageNames } from './plan-billing-usage-history'

export type PlanBillingUsageState =
  | { status: 'loading' }
  | { status: 'ok'; history: OrcaBillingUsageHistory; names: UsageNames }
  | { status: 'failed' }

/** How long the 30-day read may take before the chart says it couldn't load (with Try again). */
export const USAGE_HISTORY_TIMEOUT_MS = 15_000

/** Minutes east of UTC, so the chart's days are the viewer's local days. */
function utcOffsetMinutes(): number {
  return -new Date().getTimezoneOffset()
}

/**
 * Reads the 30-day history whenever `readKey` changes (the account, or a new billing read: the
 * status re-reads on window focus, so there's no refresh button). A re-read keeps the last answer
 * on screen until the new one lands. Owners and admins also get member and workspace names.
 */
export function usePlanBillingUsageHistory(
  readKey: string | null,
  orgId: string | null,
  selfId: string | null,
  canSeeBreakdown: boolean
): { state: PlanBillingUsageState; retry: () => void } {
  const t = useTranslate()
  const [attempt, setAttempt] = useState(0)
  const [read, setRead] = useState<
    { key: string; history: OrcaBillingUsageHistory } | { key: string; failed: true } | null
  >(null)
  const [workspaces, setWorkspaces] = useState<CloudWorkspace[] | null>(null)
  const roster = useOrgRoster(canSeeBreakdown ? orgId : null)
  // The chart's own clock: 15 s from when it mounts (or Try again, or a switch to another account)
  // to an answer, even if the read can't start yet because the account key hasn't arrived.
  const [waitExpired, setWaitExpired] = useState(false)
  const [accountEpoch, setAccountEpoch] = useState(0)
  const lastAccount = useRef<string | null>(null)
  const account = readKey?.split('|')[0] ?? null
  useEffect(() => {
    if (account && lastAccount.current && account !== lastAccount.current) {
      setAccountEpoch((epoch) => epoch + 1)
    }
    if (account) {
      lastAccount.current = account
    }
  }, [account])
  useEffect(() => {
    setWaitExpired(false)
    const timer = setTimeout(() => setWaitExpired(true), USAGE_HISTORY_TIMEOUT_MS)
    return () => clearTimeout(timer)
  }, [attempt, accountEpoch])

  useEffect(() => {
    if (!readKey) {
      return
    }
    let disposed = false
    // A read that never answers must not leave the chart as a grey box forever: give up after 15 s.
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<{ status: 'failed' }>((resolve) => {
      timer = setTimeout(() => resolve({ status: 'failed' }), USAGE_HISTORY_TIMEOUT_MS)
    })
    void Promise.race([
      window.api.orcaProfiles
        .billingUsageHistory({ utcOffsetMinutes: utcOffsetMinutes() })
        .catch(() => ({ status: 'failed' as const })),
      timeout
    ])
      .finally(() => clearTimeout(timer))
      .then((result) => {
        if (disposed) {
          return
        }
        if (result.status === 'ok') {
          setRead({ key: readKey, history: result.history })
        } else {
          // A failed re-read keeps the chart that's already showing for this account.
          setRead((previous) =>
            previous &&
            'history' in previous &&
            previous.key.split('|')[0] === readKey.split('|')[0]
              ? previous
              : { key: readKey, failed: true }
          )
        }
      })
    return () => {
      disposed = true
      clearTimeout(timer)
    }
  }, [readKey, attempt])

  useEffect(() => {
    if (!canSeeBreakdown || !orgId) {
      return
    }
    let disposed = false
    void (window.api.cloudWorkspaces?.list({ scope: 'all', archived: 'include' }) ?? null)
      ?.then((result) => {
        if (!disposed && result.ok) {
          setWorkspaces(result.value)
        }
      })
      .catch(() => {})
    return () => {
      disposed = true
    }
  }, [canSeeBreakdown, orgId])

  const retry = useCallback(() => setAttempt((count) => count + 1), [])
  const sameAccount =
    read !== null && readKey !== null && read.key.split('|')[0] === readKey.split('|')[0]
  if (!read || !sameAccount) {
    return { state: { status: waitExpired ? 'failed' : 'loading' }, retry }
  }
  if (!('history' in read)) {
    return { state: { status: 'failed' }, retry }
  }
  const members = new Map<string, string>()
  if (roster.result?.status === 'ok') {
    for (const member of roster.result.roster.members) {
      if (member.userId) {
        members.set(member.userId, member.displayName ?? member.email)
      }
    }
  }
  const titles = usageWorkspaceNames(
    (workspaces ?? []).map((workspace) => ({
      id: workspace.id,
      title: cloudWorkspaceTitle(workspace, t),
      number: workspace.number
    }))
  )
  return {
    state: {
      status: 'ok',
      history: read.history,
      names: { members, workspaces: titles, selfId }
    },
    retry
  }
}
