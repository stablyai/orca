import type { SshConnectionStatus } from '../../../../../../shared/ssh-types'
import type { WorkspaceCardFacts } from '../../../../../../shared/workspace-cards/workspace-card-facts'
import type { WorktreeGitIdentityDisplay } from '../../../../../../shared/worktree/git-identity-display'
import type { WorktreeStatus } from '../../../../../../shared/worktree-status-rollup'
import type { WorktreeCardIssueDisplay } from '../../worktree-card-meta-types'
import type { WorktreeCardPrDisplay } from '../../worktree-card-pr-display'

export type CardPreviewAgent = {
  title: string
  state: 'working' | 'blocked' | 'done' | 'idle'
  message: string
  ago: string
}

/** A made-up workspace in one state. Previews draw it from these values alone and never read or
 *  write the app store, so they are safe for any template, installed or not. */
export type CardPreviewScenario = {
  id: string
  title: string
  facts: WorkspaceCardFacts
  status: WorktreeStatus
  isSleeping: boolean
  agents: CardPreviewAgent[]
  review: WorktreeCardPrDisplay | null
  issue: WorktreeCardIssueDisplay | null
  sshStatus: SshConnectionStatus | null
  detachedHead: Extract<WorktreeGitIdentityDisplay, { kind: 'detached' }> | null
  repoColor: string
}

type Overrides = {
  [K in keyof WorkspaceCardFacts]?: Partial<WorkspaceCardFacts[K]>
}

/** Fills a scenario's facts from a plain workspace, so each scenario names only what differs. */
export function previewFacts(overrides: Overrides): WorkspaceCardFacts {
  const base: WorkspaceCardFacts = {
    ws: {
      id: 'preview',
      name: 'card-plugins',
      title: 'card-plugins',
      kind: 'git',
      path: '/work/orca/card-plugins',
      branch: 'feature/card-plugins',
      identity: 'feature/card-plugins',
      isMain: false,
      isSparse: false,
      detachedHead: false,
      isPinned: false,
      isUnread: false,
      isDeleting: false,
      isRenaming: false,
      hasRenameError: false,
      removalError: null,
      comment: ''
    },
    repo: { id: 'preview-repo', name: 'orca', ssh: false },
    host: { kind: 'local', contextLabel: null, runtimeDisconnected: false },
    git: { conflictOperation: null, remoteBranchConflict: null, cacheTimerActive: false },
    review: null,
    checks: { total: 0, passing: 0, failing: 0, pending: 0 },
    links: { count: 0, issue: false, linearIssue: false, jiraIssue: false },
    provenance: { automation: false, cli: false },
    ports: { count: 0 },
    lineage: { childCount: 0, collapsed: false, toggleable: false },
    place: {
      isActive: false,
      inPinnedSection: false,
      hideRepoBadge: false,
      showProjectName: false,
      affiliateList: false,
      deleteQuickAction: false
    },
    options: {
      style: 'classic',
      show: {
        status: true,
        unread: true,
        ci: false,
        branch: false,
        issue: true,
        linearIssue: true,
        jiraIssue: true,
        pr: true,
        automation: true,
        cli: true,
        comment: true,
        ports: true,
        inlineAgents: true,
        host: true
      },
      agentRows: 'compact'
    },
    env: { projectGroups: false },
    cardOptions: {}
  }
  return {
    ws: { ...base.ws, ...overrides.ws },
    repo: overrides.repo === null ? null : { ...base.repo!, ...overrides.repo },
    host: { ...base.host, ...overrides.host },
    git: { ...base.git, ...overrides.git },
    review: overrides.review ? { ...defaultReview, ...overrides.review } : null,
    checks: { ...base.checks, ...overrides.checks },
    links: { ...base.links, ...overrides.links },
    provenance: { ...base.provenance, ...overrides.provenance },
    ports: { ...base.ports, ...overrides.ports },
    lineage: { ...base.lineage, ...overrides.lineage },
    place: { ...base.place, ...overrides.place },
    options: { ...base.options, ...overrides.options },
    env: { ...base.env, ...overrides.env },
    cardOptions: { ...base.cardOptions, ...overrides.cardOptions }
  }
}

const defaultReview: NonNullable<WorkspaceCardFacts['review']> = {
  provider: 'github',
  number: 4182,
  title: 'Draw workspace cards from a template',
  state: 'open',
  status: 'success',
  url: 'https://github.com/example/orca/pull/4182'
}
