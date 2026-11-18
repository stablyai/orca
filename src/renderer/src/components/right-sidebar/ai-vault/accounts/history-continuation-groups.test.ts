import { expect, it } from 'vitest'
import { groupHistoryContinuations } from './history-continuation-groups'
import { searchHit } from '../../../../../../shared/ai-vault/search/ai-vault-search-test-fixture'
import { aiVaultSearchHitToSession } from '../search/ai-vault-search-session'
import type { HistoryAccountCatalogs } from './history-account-context'

it('groups explicit lineage across accounts while preserving unrelated titles and hosts', () => {
  const session = aiVaultSearchHitToSession(searchHit(), 'local')
  const catalogs: HistoryAccountCatalogs = {
    local: {
      claude: { accounts: [], activeAccountId: null },
      codex: { accounts: [], activeAccountId: null },
      settings: { historyResumeAccountsSupported: true },
      continuations: [
        {
          provider: 'codex',
          sessionId: 'original',
          rootSessionId: 'original',
          filePath: '/personal/original.jsonl',
          home: '/personal',
          accountId: null,
          openedAt: 10
        },
        {
          provider: 'codex',
          sessionId: 'continued',
          rootSessionId: 'original',
          parentSessionId: 'original',
          filePath: '/work/continued.jsonl',
          home: '/work',
          accountId: 'work',
          openedAt: 20
        }
      ]
    }
  }
  const grouped = groupHistoryContinuations(
    [
      { ...session, agent: 'codex', sessionId: 'original' },
      { ...session, agent: 'codex', sessionId: 'continued' },
      { ...session, agent: 'codex', sessionId: 'unrelated' },
      { ...session, agent: 'codex', sessionId: 'original', executionHostId: 'ssh:other' }
    ],
    catalogs
  )
  expect(grouped.map((entry) => [entry.executionHostId, entry.sessionId])).toEqual([
    ['local', 'continued'],
    ['local', 'unrelated'],
    ['ssh:other', 'original']
  ])
  expect(grouped[0].continuationVersions?.map((entry) => entry.sessionId)).toEqual([
    'continued',
    'original'
  ])
  const personal = groupHistoryContinuations(
    [{ ...session, agent: 'codex', sessionId: 'original' }],
    catalogs,
    (entry) => entry.codexHome === '/personal'
  )
  expect(personal.map((entry) => entry.sessionId)).toEqual(['original'])
  expect(personal[0].continuationVersions?.map((entry) => entry.sessionId)).toEqual([
    'continued',
    'original'
  ])
})
