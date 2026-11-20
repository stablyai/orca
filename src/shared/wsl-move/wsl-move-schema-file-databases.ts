/** The database each schema file creates tables in; a new schema file fails the census. */
export const SQLITE_SCHEMA_FILE_DATABASES: Record<string, string> = {
  'src/main/ai-vault-search/storage/session-search-query-schema.ts': 'ai-vault-search',
  'src/main/ai-vault-search/storage/session-search-schema.ts': 'ai-vault-search',
  'src/main/ai-vault-search/storage/session-search-write-buffer.ts': 'ai-vault-search-staging',
  'src/main/ai-vault/parse-cache/session-parse-cache-database.ts': 'ai-vault-parse-cache',
  'src/main/ai-vault/parse-cache/session-scope-cwds-table.ts': 'ai-vault-parse-cache',
  'src/main/browser/cookies/staging/browser-cookie-staged-import.ts': 'browser-cookie-import',
  'src/main/native-chat/agent-session-attachments/agent-session-attachment-claims.ts':
    'agent-session-journal',
  'src/main/native-chat/agent-session-journal/writing/command-receipt-schema.ts':
    'agent-session-journal',
  'src/main/native-chat/agent-session-journal/database/journal-database-schema.ts':
    'agent-session-journal',
  'src/main/native-chat/agent-session-journal/outcomes/journal-outcome-format.ts':
    'agent-session-journal',
  'src/main/native-chat/agent-session-journal/history-import/journal-pi-active-branch.ts':
    'pi-branch-import',
  'src/main/native-chat/agent-session-journal/queued-messages/queued-message-schema.ts':
    'agent-session-journal',
  'src/main/persistence/profile-state/database/profile-state-database-schema.ts': 'profile-state',
  'src/main/runtime/orchestration/db/schema/create-core-tables-sql.ts': 'orchestration',
  'src/main/runtime/orchestration/db/schema/create-graph-tables-sql.ts': 'orchestration',
  'src/main/runtime/orchestration/db/schema/migrate-legacy-contract-storage.ts': 'orchestration',
  'src/main/runtime/orchestration/db/schema/migrate-role-mailbox-delivery-v34.ts': 'orchestration',
  'src/main/runtime/orchestration/db/schema/migrate-v13-v30.ts': 'orchestration',
  'src/main/runtime/orchestration/db/schema/migrate-v2-v12.ts': 'orchestration',
  'src/main/runtime/orchestration/db/schema/migrate-v35.ts': 'orchestration',
  'src/main/runtime/orchestration/db/schema/migrate-v39.ts': 'orchestration',
  'src/main/runtime/orchestration/db/schema/migrate.ts': 'orchestration',
  'src/main/runtime/orchestration/db/remote-owned/worker-placement-catalog-store.ts':
    'orchestration',
  'src/main/runtime/orchestration/db/reset/removed-orchestration-work-store.ts': 'orchestration',
  'src/main/runtime/orchestration/db/mutation-receipts/mutation-receipt-capacity.ts':
    'orchestration',
  // Test fixtures that mirror third-party agent and browser databases.
  'src/main/ai-vault/scanners/opencode/sqlite/session-scanner-opencode-sqlite-fixture.ts':
    'test-fixture',
  'src/main/ai-vault/scanner-fixtures/session-scanner-test-fixtures.ts': 'test-fixture',
  'src/main/browser/cookies/browser-cookie-import-test-database.ts': 'test-fixture',
  'src/main/codex/history/index/codex-state-db-test-fixture.ts': 'test-fixture',
  'src/main/opencode-usage/opencode-usage-sqlite-fixture.ts': 'test-fixture'
}
