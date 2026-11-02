import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import type { ProjectConversationListProps } from './ProjectConversationList'
import { toAiVaultProjectKey } from '../../../../shared/ai-vault-project-key'

export const conversationRepos: Repo[] = [
  {
    id: 'orca',
    displayName: 'Orca',
    path: '/projects/orca',
    badgeColor: '',
    addedAt: 0,
    executionHostId: 'local',
    repoIcon: { type: 'emoji', emoji: '🐋' }
  },
  {
    id: 'djinn',
    displayName: 'Djinn',
    path: '/projects/djinn',
    badgeColor: '',
    addedAt: 0,
    executionHostId: 'local',
    repoIcon: { type: 'emoji', emoji: '✨' }
  }
]
export const conversationWorktrees: Worktree[] = conversationRepos.map((repo) => ({
  id: `${repo.id}::${repo.path}`,
  repoId: repo.id,
  path: repo.path,
  displayName: 'main',
  branch: 'refs/heads/main',
  head: 'abc',
  isBare: false,
  isMainWorktree: true,
  comment: '',
  linkedIssue: null,
  linkedPR: null,
  linkedLinearIssue: null,
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 0
}))
export const conversationCatalog = projectHostSetupProjectionFromRepos(conversationRepos)
const titles = [
  'Keep history steady while loading',
  'Make project navigation clearer',
  'Restore image attachments on mobile',
  'Improve keyboard navigation',
  'Show provider account quotas',
  'Review saved worker roles',
  'Update the Russian locale'
]
export const conversationSessions: AiVaultSession[] = titles.map((title, index) => ({
  id: `chat-${index}`,
  sessionId: `chat-${index}`,
  executionHostId: 'local',
  agent: index % 3 === 0 ? 'claude' : index % 3 === 1 ? 'codex' : 'gemini',
  title,
  cwd: '/projects/orca',
  branch: null,
  model: null,
  filePath: '/logs/chat',
  codexHome: null,
  createdAt: '2026-10-26T00:00:00Z',
  updatedAt: `2026-10-26T00:00:0${7 - index}Z`,
  modifiedAt: '2026-10-26T00:00:00Z',
  messageCount: 2,
  totalTokens: 0,
  previewMessages: [],
  queuedMessageCount: 0,
  subagentTranscriptCount: 0,
  resumeCommand: '',
  subagent: null
}))
export const conversationSessionProjects = new Map(
  conversationSessions.map((session) => [
    session.id,
    {
      kind: 'repo' as const,
      key: toAiVaultProjectKey(conversationCatalog.setups[0]?.projectId, 'orca') ?? 'repo:orca',
      label: 'Orca',
      repoId: 'orca',
      hostKey: 'local' as const
    }
  ])
)
export function conversationListProps(): ProjectConversationListProps {
  return {
    groups: [{ key: 'orca', label: 'Orca', sessions: conversationSessions }],
    sessionProjects: conversationSessionProjects,
    collapsedGroups: new Set(),
    loading: false,
    sessionsCount: 7,
    filteredSessionsCount: 7,
    noAgentsSelected: false,
    error: null,
    vaultScope: 'all',
    buildResumeStartup: () => ({ command: '' }),
    getOriginalPaneTarget: () => null,
    isStructuredSessionOpen: () => false,
    getSessionLiveState: () => null,
    getWorktreeInfo: () => null,
    getSessionResumeState: () => ({
      blocked: false,
      worktreeId: conversationWorktrees[0]!.id,
      usesSessionWorktree: true
    }),
    getSessionResumeActions: () => ({
      worktree: { worktreeId: conversationWorktrees[0]!.id, disabled: false },
      newTab: { worktreeId: conversationWorktrees[0]!.id, disabled: false }
    }),
    getSessionResumeInChat: () => ({ available: true, workspaceId: conversationWorktrees[0]!.id }),
    onToggleGroup: () => {},
    onJumpToOriginalPane: () => {},
    onJumpToWorktree: () => {},
    onResume: () => {},
    onContinueInNewSession: () => {},
    onResumeInNewChat: () => {},
    onResumeInNewCli: () => {},
    onCopyResume: () => {},
    onCopyId: () => {},
    onCopyPath: () => {},
    onOpenLog: () => {},
    onRevealLog: () => {},
    onOpenCwd: () => {},
    onRequestDelete: () => {}
  }
}
export const conversationStore = {
  activeTabId: null,
  activeGroupIdByWorktree: {},
  groupsByWorktree: {},
  unifiedTabsByWorktree: {},
  repos: conversationRepos,
  projects: conversationCatalog.projects,
  projectHostSetups: conversationCatalog.setups,
  worktreesByRepo: { orca: [conversationWorktrees[0]!], djinn: [conversationWorktrees[1]!] },
  activeWorktreeId: conversationWorktrees[1]!.id,
  projectOrderBy: 'manual' as const
}
