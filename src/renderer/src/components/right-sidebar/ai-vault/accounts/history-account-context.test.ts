import { expect, it } from 'vitest'
import { historyAccountInfo, type HistoryAccountCatalog } from './history-account-context'
import { searchHit } from '../../../../../../shared/ai-vault/search/ai-vault-search-test-fixture'
import { aiVaultSearchHitToSession } from '../search/ai-vault-search-session'

it('does not infer last-used account from storage or workspace selection', () => {
  const session = {
    ...aiVaultSearchHitToSession(searchHit(), 'local'),
    agent: 'codex' as const,
    codexHome: 'C:\\orca\\codex-accounts\\personal\\home',
    filePath: 'C:\\orca\\codex-accounts\\personal\\home\\sessions\\session.jsonl'
  }
  const catalog: HistoryAccountCatalog = {
    claude: { accounts: [], activeAccountId: null },
    codex: { accounts: [], activeAccountId: 'personal' },
    settings: {
      codexWorkspaceAccounts: { 'folder:repo': 'work' },
      historyResumeAccountsSupported: true
    }
  }
  expect(historyAccountInfo(session, catalog, 'folder:repo')).toMatchObject({
    sourceId: 'personal',
    lastAccountId: undefined
  })
  expect(historyAccountInfo(session, catalog, 'folder:other')).toMatchObject({
    sourceId: 'personal',
    lastAccountId: undefined
  })
})

it('recognizes a Claude account in a custom home without guessing from the selected account', () => {
  const session = {
    ...aiVaultSearchHitToSession(searchHit(), 'local'),
    agent: 'claude' as const,
    accountHome: { variable: 'CLAUDE_CONFIG_DIR' as const, path: '/profiles/personal' },
    filePath: '/profiles/personal/projects/repo/session.jsonl'
  }
  const catalog: HistoryAccountCatalog = {
    claude: {
      activeAccountId: null,
      accounts: [
        {
          id: 'personal',
          email: 'personal@example.com',
          home: '/profiles/personal',
          authMethod: 'unknown',
          createdAt: 0,
          updatedAt: 0,
          lastAuthenticatedAt: 0
        }
      ]
    },
    codex: { accounts: [], activeAccountId: null },
    settings: { historyResumeAccountsSupported: true }
  }
  expect(historyAccountInfo(session, catalog, 'folder:repo')).toMatchObject({
    sourceId: 'personal',
    lastAccountId: undefined
  })
  expect(
    historyAccountInfo(
      { ...session, accountHome: undefined, filePath: '/unknown/session.jsonl' },
      catalog,
      'folder:repo'
    )
  ).toMatchObject({ sourceId: undefined, lastAccountId: undefined })
})

it('labels a removed last-used account as unavailable', () => {
  const session = {
    ...aiVaultSearchHitToSession(searchHit(), 'local'),
    agent: 'codex' as const,
    filePath: '/personal/session.jsonl'
  }
  const catalog: HistoryAccountCatalog = {
    claude: { accounts: [], activeAccountId: null },
    codex: { accounts: [], activeAccountId: null },
    continuations: [
      {
        provider: 'codex',
        sessionId: session.sessionId,
        filePath: session.filePath,
        home: '/personal',
        rootSessionId: session.sessionId,
        accountId: 'removed-account',
        openedAt: 1
      }
    ],
    settings: { historyResumeAccountsSupported: true }
  }
  expect(historyAccountInfo(session, catalog)?.lastAccountLabel).toContain('unavailable')
})
