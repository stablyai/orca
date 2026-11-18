import { historyAccountInfo } from './history-account-context'
import type { AiVaultSession } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import { groupHistoryContinuations } from './history-continuation-groups'
import { aiVaultSessionCountLabel } from '../session-list/AiVaultSessionListBar'
import { useMemo, useState } from 'react'
import type { HistoryAccountCatalogs } from './history-account-context'
export function availableHistoryAccountFilter(
  selected: string,
  catalogs: HistoryAccountCatalogs
): string {
  const available = Object.entries(catalogs).flatMap(([host, catalog]) =>
    (['codex', 'claude'] as const).flatMap((provider) =>
      [null, ...catalog[provider].accounts.map((account) => account.id)].map((id) =>
        JSON.stringify([host, provider, id])
      )
    )
  )
  return available.includes(selected) ? selected : 'all'
}

export function useHistoryAccountFilter(catalogs: HistoryAccountCatalogs) {
  const [selected, setSelected] = useState('all')
  return [availableHistoryAccountFilter(selected, catalogs), setSelected] as const
}

export function historyConversationCountLabel(
  sessions: readonly AiVaultSession[],
  catalogs: HistoryAccountCatalogs,
  shown: number,
  t: Parameters<typeof aiVaultSessionCountLabel>[2]
) {
  return aiVaultSessionCountLabel(shown, groupHistoryContinuations(sessions, catalogs).length, t)
}

export function useHistoryAccountSessions(
  sessions: readonly AiVaultSession[],
  accountCatalogs: HistoryAccountCatalogs,
  accountFilter: string
) {
  return useMemo(
    () =>
      accountFilter === 'all'
        ? groupHistoryContinuations(sessions, accountCatalogs)
        : groupHistoryContinuations(sessions, accountCatalogs, (session) => {
            const sourceId = historyAccountInfo(
              session,
              accountCatalogs[session.executionHostId]
            )?.sourceId
            return (
              sourceId !== undefined &&
              JSON.stringify([session.executionHostId, session.agent, sourceId]) === accountFilter
            )
          }),
    [sessions, accountFilter, accountCatalogs]
  )
}
