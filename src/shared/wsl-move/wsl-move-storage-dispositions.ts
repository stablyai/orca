import {
  moveDisposition,
  notApplicableDisposition,
  type WslMoveFieldDisposition
} from './wsl-move-dispositions'

/** Census tests require a disposition for each renderer module using localStorage. */
export const LOCAL_STORAGE_MODULE_DISPOSITIONS: Record<string, WslMoveFieldDisposition> = {
  'src/renderer/src/lib/quick-open-file-history.ts': {
    disposition: 'rewrite-desktop',
    item: 42
  },
  'src/renderer/src/components/editor/ipynb-kernel-store.ts': {
    disposition: 'rewrite-desktop',
    item: 43
  },
  'src/renderer/src/lib/agent-session/launch/structured-agent-session-launch-persistence.ts':
    notApplicableDisposition(
      44,
      'Chats stay local on the desktop (owner decision C), so their launch records stay as written.'
    ),
  'src/renderer/src/components/editor/file-view-preference-storage.ts': {
    disposition: 'rewrite-desktop',
    item: 72,
    note: 'CSV column widths and PDF scale, keyed by worktree id, runtime and file path.'
  },
  'src/renderer/src/components/native-chat/native-chat-composer-draft-journal.ts':
    notApplicableDisposition(45, 'Keyed by session id.'),
  'src/renderer/src/components/native-chat/native-chat-composer-draft-storage.ts':
    notApplicableDisposition(45, 'Keyed by session id.'),
  'src/renderer/src/components/native-chat/structured-agent-session-legacy-outbox.ts':
    notApplicableDisposition(45, 'Keyed by session id.'),
  'src/renderer/src/lib/wsl-move-renderer-store-rewrites.ts': notApplicableDisposition(
    62,
    "The mover's own record of which renderer rewrites landed; keyed by move id."
  ),
  'src/renderer/src/lib/desktop-created-server-tabs.ts': notApplicableDisposition(
    60,
    'Tabs this desktop created in a paired server workspace, keyed by that server; a local or WSL project has none.'
  ),
  'src/renderer/src/store/slices/worktrees/session/worktree-visit-recency.ts':
    notApplicableDisposition(
      32,
      'Web client only; the desktop keeps visit recency in the session.'
    ),
  'src/renderer/src/lib/workspace-view-storage.ts': notApplicableDisposition(
    62,
    'Per-device presentation views; unavailable host-qualified panel references remain placeholders after a move.'
  ),
  ...Object.fromEntries(
    [
      'src/renderer/src/components/browser-pane/annotate/use-markup-draw-hint.ts',
      'src/renderer/src/components/feature-tips/FeatureTipsModal.tsx',
      'src/renderer/src/components/feature-wall/BrowserUseSkillSetupCard.tsx',
      'src/renderer/src/components/feature-wall/feature-wall-completion-persistence.ts',
      'src/renderer/src/components/floating-terminal/floating-terminal-panel-bounds.ts',
      'src/renderer/src/components/floating-terminal/floating-terminal-panel-render-probe.ts',
      'src/renderer/src/components/floating-terminal/floating-terminal-panel-test-harness.ts',
      'src/renderer/src/components/floating-terminal/floating-terminal-panel-view-state.ts',
      'src/renderer/src/components/floating-terminal/floating-terminal-trigger-position.ts',
      'src/renderer/src/components/floating-terminal/use-floating-terminal-orchestration-dismissal.ts',
      'src/renderer/src/components/github-project/column-widths.ts',
      'src/renderer/src/components/github-project/columns.ts',
      'src/renderer/src/components/github-project/roadmap-zoom-preference.ts',
      'src/renderer/src/components/jira-linked-view-storage.ts',
      'src/renderer/src/components/jira-list-columns.ts',
      'src/renderer/src/components/jira-prompt-templates.ts',
      'src/renderer/src/components/jira-view-mode-storage.ts',
      'src/renderer/src/components/landing-preflight-dismissal.ts',
      'src/renderer/src/components/linear-issue-view-storage.ts',
      'src/renderer/src/components/native-chat/NativeChatStructuredSession.test-harness.tsx',
      'src/renderer/src/components/onboarding/onboarding-feature-setup.ts',
      'src/renderer/src/components/pet/PetOverlay.tsx',
      'src/renderer/src/components/right-sidebar/ai-vault-view-options-persistence.ts',
      'src/renderer/src/components/right-sidebar/pr-comment-presentation.ts',
      'src/renderer/src/components/settings/BrowserUsePane.tsx',
      'src/renderer/src/components/settings/local-network-connection-history.ts',
      'src/renderer/src/components/sidebar/linear-agent-skill-runtime.ts',
      'src/renderer/src/components/sidebar/LinearAgentSkillSetupPrompt.tsx',
      'src/renderer/src/components/sidebar/mobile-sidebar-onboarding-badge.ts',
      'src/renderer/src/components/sidebar/SeveredTerminalDaemonBanner.tsx',
      'src/renderer/src/components/sidebar/SidebarToolbar.tsx',
      'src/renderer/src/components/terminal-pane/terminal-freeze-breadcrumbs.ts',
      'src/renderer/src/components/terminal-pane/terminal-render-desync-trigger.ts',
      'src/renderer/src/components/terminal-pane/terminal-startup-timing.ts',
      'src/renderer/src/components/UnexpectedSignoutCard.tsx',
      'src/renderer/src/lib/feature-education-telemetry.ts',
      'src/renderer/src/lib/orchestration-setup-state.ts',
      'src/renderer/src/lib/terminal-shortcut-capture-notification.tsx',
      'src/renderer/src/web/preload-api/web-keybindings-api.ts',
      'src/renderer/src/web/preload-api/web-onboarding-api.ts',
      'src/renderer/src/web/preload-api/web-preferences-store.ts',
      'src/renderer/src/web/preload-api/web-settings-api.ts',
      'src/renderer/src/web/preload-api/web-storage.ts',
      'src/renderer/src/web/preload-api/web-workspace-session-api.ts',
      'src/renderer/src/web/web-preload-api-test-harness.ts',
      'src/renderer/src/web/web-runtime-credential-source.ts',
      'src/renderer/src/web/web-runtime-environment.ts',
      'src/shared/default-global-settings.ts'
    ].map((path) => [
      path,
      notApplicableDisposition(62, 'Global preference or web-client storage.')
    ])
  )
}

/** The database each schema file creates tables in; a new schema file fails the census. */
export const SQLITE_SCHEMA_FILE_DATABASES: Record<string, string> = {
  'src/main/ai-vault-search/session-search-query-schema.ts': 'ai-vault-search',
  'src/main/ai-vault-search/session-search-schema.ts': 'ai-vault-search',
  'src/main/ai-vault-search/session-search-write-buffer.ts': 'ai-vault-search-staging',
  'src/main/ai-vault/session-parse-cache-database.ts': 'ai-vault-parse-cache',
  'src/main/ai-vault/session-scope-cwds-table.ts': 'ai-vault-parse-cache',
  'src/main/browser/cookies/browser-cookie-staged-import.ts': 'browser-cookie-import',
  'src/main/native-chat/agent-session-attachments/agent-session-attachment-claims.ts':
    'agent-session-journal',
  'src/main/native-chat/agent-session-journal/command-receipt-schema.ts': 'agent-session-journal',
  'src/main/native-chat/agent-session-journal/journal-database-schema.ts': 'agent-session-journal',
  'src/main/native-chat/agent-session-journal/journal-pi-active-branch.ts': 'pi-branch-import',
  'src/main/native-chat/agent-session-journal/queued-message-schema.ts': 'agent-session-journal',
  'src/main/persistence/profile-state/profile-state-database-schema.ts': 'profile-state',
  'src/main/runtime/orchestration/db/schema/create-core-tables-sql.ts': 'orchestration',
  'src/main/runtime/orchestration/db/schema/create-graph-tables-sql.ts': 'orchestration',
  'src/main/runtime/orchestration/db/schema/migrate-legacy-contract-storage.ts': 'orchestration',
  'src/main/runtime/orchestration/db/schema/migrate-role-mailbox-delivery-v34.ts': 'orchestration',
  'src/main/runtime/orchestration/db/schema/migrate-v13-v30.ts': 'orchestration',
  'src/main/runtime/orchestration/db/schema/migrate-v2-v12.ts': 'orchestration',
  'src/main/runtime/orchestration/db/schema/migrate-v35.ts': 'orchestration',
  'src/main/runtime/orchestration/db/schema/migrate-v39.ts': 'orchestration',
  'src/main/runtime/orchestration/db/schema/migrate.ts': 'orchestration',
  'src/main/runtime/orchestration/db/reset/removed-orchestration-work-store.ts': 'orchestration',
  'src/main/runtime/orchestration/mutation-receipt-capacity.ts': 'orchestration',
  // Test fixtures that mirror third-party agent and browser databases.
  'src/main/ai-vault/session-scanner-opencode-sqlite-fixture.ts': 'test-fixture',
  'src/main/ai-vault/session-scanner-test-fixtures.ts': 'test-fixture',
  'src/main/browser/cookies/browser-cookie-import-test-database.ts': 'test-fixture',
  'src/main/codex/codex-state-db-test-fixture.ts': 'test-fixture',
  'src/main/opencode-usage/opencode-usage-sqlite-fixture.ts': 'test-fixture'
}

const tables = (
  database: string,
  names: readonly string[],
  row: WslMoveFieldDisposition
): [string, WslMoveFieldDisposition][] => names.map((name) => [`${database}.${name}`, row])

/** Tables by `<database>.<table>`. Migration copies (`*_new`, `*_v35`) sit with what they rebuild. */
export const SQLITE_TABLE_DISPOSITIONS: Record<string, WslMoveFieldDisposition> =
  Object.fromEntries([
    ...tables(
      'agent-session-journal',
      [
        'agent_session_records',
        'agent_session_operations',
        'agent_session_tabs',
        'agent_session_store_meta',
        'agent_session_retired_claim_keys',
        'agent_session_command_receipts',
        'agent_session_attachment_claims',
        'agent_session_attachment_sweeps',
        'journal_imports',
        'journal_repairs',
        'journal_rows',
        'journal_sessions',
        'journal_set_aside',
        'queued_messages'
      ],
      notApplicableDisposition(
        52,
        'Native chat journal: chats stay local on the desktop (owner decision C), never moved.'
      )
    ),
    ...tables('orchestration', ['worker_dispatches', 'worker_terminal_resources'], {
      disposition: 'rewrite-desktop',
      item: 53,
      note: "worktree_id of a settled local dispatch becomes the host's id; a live one holds the store until it settles. Chat and federated workers and JSON receipts stay as written."
    }),
    ...tables(
      'orchestration',
      ['remote_dispatch_attachments'],
      notApplicableDisposition(
        53,
        'What this computer told a remote home as its worker; that home reaches this runtime, which does not serve the host ids.'
      )
    ),
    ...tables(
      'orchestration',
      ['federated_dispatches', 'federation_relay_items'],
      notApplicableDisposition(53, "Another host's worktree ids and relayed messages.")
    ),
    ...tables(
      'orchestration',
      ['dispatch_contexts', 'runs', 'tasks', 'run_coordinator_handles', 'coordinator_runs'],
      notApplicableDisposition(
        53,
        'Handles, pane keys (tab and leaf ids are kept) and the host scope a process ran in, which stays true of it.'
      )
    ),
    ...tables(
      'orchestration',
      [
        'worker_terminal_archives',
        'worker_terminal_archives_v39',
        'decision_gates',
        'deliveries',
        'deliveries_new',
        'deliveries_v35',
        'messages',
        'messages_new',
        'question_threads',
        'remote_questions',
        'attempt_observation_facts',
        'structured_pointer_operations'
      ],
      notApplicableDisposition(53, 'Keyed by run, task, dispatch, message or handle ids.')
    ),
    ...tables(
      'orchestration',
      [
        'mutation_receipts',
        'mutation_receipt_ledger',
        'mutation_caller_identities',
        'legacy_adoptions',
        'legacy_compatibility_principals',
        'legacy_mail_receipts',
        'legacy_operation_receipts',
        'removed_orchestration_work',
        'removed_orchestration_work_coverage'
      ],
      notApplicableDisposition(
        53,
        'Idempotency receipts: a replay returns the bytes first answered.'
      )
    ),
    ...tables(
      'orchestration',
      ['won'],
      notApplicableDisposition(53, "Not a table: the census reads it from migrate.ts's comment.")
    ),
    ...tables('profile-state', ['profile_state_documents'], {
      disposition: 'per-field',
      item: 1,
      note: 'Holds PersistedState itself.'
    }),
    ...tables('profile-state', ['profile_state_meta'], notApplicableDisposition(62)),
    ...tables(
      'profile-state',
      ['${PROFILE_STATE_AUTOMATION_RUNS_TABLE}'],
      moveDisposition(19, { note: 'PersistedState.automationRuns.' })
    ),
    ...tables(
      'profile-state',
      ['${PROFILE_STATE_AUTOMATION_RUNS_META_TABLE}'],
      notApplicableDisposition(19, 'Bookkeeping for automationRuns.')
    ),
    ...tables(
      'ai-vault-search',
      ['files', 'messages', 'messages_fts', 'messages_vocab', 'meta', 'sessions'],
      notApplicableDisposition(57, 'AI Vault search index; rebuilt from transcripts.')
    ),
    ...tables(
      'ai-vault-search-staging',
      ['messages'],
      notApplicableDisposition(57, 'Read-local search staging; deleted when its connection closes.')
    ),
    ...tables(
      'ai-vault-parse-cache',
      ['meta', 'rows', 'scope_cwds'],
      notApplicableDisposition(57, 'Session History parse cache; rebuilt from transcripts.')
    ),
    ...tables(
      'browser-cookie-import',
      ['${IMPORT_SCOPE_TABLE}'],
      notApplicableDisposition(58, 'Cookie import staging; the partition is bound, not copied.')
    ),
    ...tables(
      'pi-branch-import',
      ['entries'],
      notApplicableDisposition(52, 'Operation-local Pi import scratch, outside workspace state.')
    ),
    ...tables(
      'test-fixture',
      [
        'backfill_state',
        'cookies',
        'message',
        'part',
        'project',
        'session',
        'session_message',
        'session_v2'
      ],
      notApplicableDisposition(56, "A third-party agent's own database, inside the distro.")
    )
  ])
