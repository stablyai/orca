import { ConfirmationDialogProvider } from '@/components/confirmation-dialog'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { makeRepo, makeWorktree } from '../../../worktree-jump/worktree-jump-palette-test-fixtures'
import type {
  AiVaultListResult,
  AiVaultSession
} from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import AiVaultSessionHistoryDialog from './AiVaultSessionHistoryDialog'

const WORKTREE = 'repo-1::/repos/repo-1/launcher'
const PATH = '/repos/repo-1/launcher'
const now = Date.now()

function session(index: number, agent: AiVaultSession['agent'], title: string): AiVaultSession {
  const modifiedAt = new Date(now - (index + 1) * 47 * 60_000).toISOString()
  return {
    id: `${agent}-${index}`,
    executionHostId: 'local',
    agent,
    sessionId: `0000000${index}-aaaa-bbbb-cccc-dddddddddddd`,
    title,
    cwd: PATH,
    branch: 'feat/launcher-resume-session',
    model: agent === 'claude' ? 'opus' : 'gpt-5',
    filePath: `/home/me/.${agent}/sessions/${index}.jsonl`,
    codexHome: null,
    createdAt: modifiedAt,
    updatedAt: modifiedAt,
    modifiedAt,
    messageCount: 12 + index * 7,
    totalTokens: 40_000 + index * 9_000,
    previewMessages: [
      { role: 'user', text: title, timestamp: modifiedAt },
      { role: 'assistant', text: 'Done. Tests and typecheck pass.', timestamp: modifiedAt }
    ],
    queuedMessageCount: 0,
    subagentTranscriptCount: 0,
    resumeCommand: `${agent} --resume`,
    subagent: null
  }
}

const sessions = [
  session(0, 'claude', 'Add Resume session to the agent launch menu'),
  session(1, 'claude', 'Investigate flaky tab-bar focus test'),
  session(2, 'codex', 'Refactor the terminal send command'),
  session(3, 'claude', 'Review i18n keys across locales'),
  session(4, 'claude', 'Fix session history filter on hosts')
]

export const fromLaunchMenu = defineFixture({
  width: 960,
  store: {
    activeRepoId: 'repo-1',
    activeWorktreeId: WORKTREE,
    repos: [makeRepo()],
    worktreesByRepo: { 'repo-1': [makeWorktree(WORKTREE, 'launcher', { path: PATH })] },
    activeModal: 'agent-session-history',
    modalData: { worktreeId: WORKTREE, initialQuery: '', agent: 'claude' }
  },
  setup: () => {
    const result: AiVaultListResult = {
      sessions,
      issues: [],
      scannedAt: new Date(now).toISOString()
    }
    Object.assign(window.api.aiVault, {
      listSessions: async () => result,
      cancelListSessions: async () => undefined
    })
  },
  render: () => (
    <div className="h-[720px] bg-background">
      <ConfirmationDialogProvider>
        <AiVaultSessionHistoryDialog />
      </ConfirmationDialogProvider>
    </div>
  ),
  interact: async () => {
    await new Promise((resolve) => setTimeout(resolve, 800))
  }
})
