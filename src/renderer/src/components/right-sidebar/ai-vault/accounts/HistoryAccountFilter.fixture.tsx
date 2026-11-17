import { useState } from 'react'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { HistoryAccountFilter } from './HistoryAccountFilter'
import { HistoryAccountContext, type HistoryAccountCatalog } from './history-account-context'
import { VaultSessionRow } from '../session-list/AiVaultSessionRow'
import type { AiVaultSession } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'

const catalog: HistoryAccountCatalog = {
  claude: { accounts: [], activeAccountId: null },
  codex: {
    activeAccountId: 'personal',
    accounts: ['personal', 'work'].map((id) => ({
      id,
      email: `${id}@example.com`,
      displayName: id === 'personal' ? 'Personal' : 'Work',
      createdAt: 0,
      updatedAt: 0,
      lastAuthenticatedAt: 0
    }))
  },
  settings: {
    codexWorkspaceAccounts: { 'folder:orca': 'work' },
    historyResumeAccountsSupported: true
  },
  continuations: [
    {
      provider: 'codex',
      sessionId: 'demo',
      filePath: '/orca/codex-accounts/personal/home/sessions/demo.jsonl',
      home: '/orca/codex-accounts/personal/home',
      rootSessionId: 'demo',
      accountId: 'personal',
      openedAt: 1
    }
  ]
}
const session: AiVaultSession = {
  id: 'demo',
  agent: 'codex',
  sessionId: 'demo',
  title: 'Continue the workspace account implementation',
  executionHostId: 'local',
  cwd: '/projects/orca',
  branch: 'feature/accounts',
  model: 'gpt-6.1-sol',
  filePath: '/orca/codex-accounts/personal/home/sessions/demo.jsonl',
  codexHome: '/orca/codex-accounts/personal/home',
  createdAt: null,
  updatedAt: null,
  modifiedAt: '2026-11-17T10:00:00Z',
  messageCount: 159,
  queuedMessageCount: 0,
  subagentTranscriptCount: 0,
  resumeCommand: 'codex resume demo',
  subagent: null,
  totalTokens: 1000,
  previewMessages: [
    {
      role: 'assistant',
      text: 'The account selection and session history changes are ready for review.',
      timestamp: null
    }
  ]
}
const noop = () => {}
function HistoryPreview({ expanded = false }: { expanded?: boolean }) {
  const [filter, setFilter] = useState<string>('all')
  return (
    <HistoryAccountContext value={{ catalogs: { local: catalog }, workspaceId: 'folder:orca' }}>
      <div className="bg-sidebar py-3 text-foreground">
        <p className="px-3 pb-3 text-sm font-medium">Agent Session History</p>
        <HistoryAccountFilter value={filter} onChange={setFilter} catalogs={{ local: catalog }} />
        <VaultSessionRow
          session={
            expanded
              ? {
                  ...session,
                  continuationVersions: [
                    ...catalog.continuations!,
                    {
                      ...catalog.continuations![0],
                      sessionId: 'work-continuation',
                      parentSessionId: 'demo',
                      accountId: 'work',
                      home: '/orca/codex-accounts/work/home',
                      filePath: '/orca/codex-accounts/work/home/sessions/work-continuation.jsonl',
                      openedAt: Date.UTC(2026, 10, 17, 10)
                    }
                  ]
                }
              : session
          }
          liveState={null}
          resumeStartup={{ command: 'codex resume demo' }}
          realHomeResumeStartup={{ command: 'codex resume demo' }}
          worktreeInfo={null}
          vaultScope="workspace"
          detailsExpanded={expanded}
          resumeDisabled={false}
          onToggleDetails={noop}
          showJumpToWorktree={false}
          onResume={noop}
          resumeLabel="Resume"
          resumeActions={{
            worktree: { worktreeId: 'folder:orca', disabled: false },
            newTab: { worktreeId: 'folder:orca', disabled: false }
          }}
          onResumeInWorktree={noop}
          onResumeInNewTab={noop}
          onCopyId={noop}
          onResumeVersion={noop}
        />
      </div>
    </HistoryAccountContext>
  )
}
export const narrow = defineFixture({ width: 320, render: () => <HistoryPreview /> })
export const sidebar = defineFixture({ width: 540, render: () => <HistoryPreview /> })
export const versions = defineFixture({
  width: 360,
  render: () => <HistoryPreview expanded />,
  interact: (frame) => frame.querySelector('details')?.setAttribute('open', '')
})
