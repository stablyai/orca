/** Fact model major; minors only add fields, and a missing path reads as `null`. */
export const WORKSPACE_CARD_FACTS_VERSION = 1

export type WorkspaceCardStyle = 'classic' | 'compact' | 'new'

/** The person's card property toggles (Show properties), keyed for expressions. */
export type WorkspaceCardShowOptions = {
  status: boolean
  unread: boolean
  ci: boolean
  branch: boolean
  issue: boolean
  linearIssue: boolean
  jiraIssue: boolean
  pr: boolean
  automation: boolean
  cli: boolean
  comment: boolean
  ports: boolean
  inlineAgents: boolean
  host: boolean
}

export type WorkspaceCardAgentFacts = {
  /** The agent's tab title, such as `Claude`. */
  title: string
  /** The agent product, such as `claude` or `codex`. */
  agent: string
  /** `working`, `blocked`, `done` or `idle`. */
  state: string
  /** The agent's latest prompt or message, when it reported one. */
  message: string
  /** When the agent entered this state, in epoch milliseconds. */
  since: number
}

/** What a card template can read about one workspace. Host-neutral: SSH and server workspaces
 *  report through `host`, and folder workspaces have `kind: 'folder'` with git facts empty. */
export type WorkspaceCardFacts = {
  ws: {
    id: string
    /** The stored name. */
    name: string
    /** The name the card shows (the new style may derive it from a linked issue or PR). */
    title: string
    kind: 'git' | 'folder'
    path: string
    /** Short branch name; empty for folders and detached HEADs. */
    branch: string
    /** Branch, or the folder path where project groups show it; null when neither applies. */
    identity: string | null
    isMain: boolean
    isSparse: boolean
    detachedHead: boolean
    isPinned: boolean
    isUnread: boolean
    isDeleting: boolean
    /** The title is being edited inline. */
    isRenaming: boolean
    hasRenameError: boolean
    removalError: string | null
    comment: string
  }
  repo: { id: string; name: string; ssh: boolean } | null
  host: {
    kind: 'local' | 'ssh' | 'runtime'
    /** The host label the list shows beside cards from another host, if any. */
    contextLabel: string | null
    runtimeDisconnected: boolean
  }
  git: {
    /** `merge`, `rebase`, `cherry-pick` or `unknown` while one is in progress. */
    conflictOperation: string | null
    remoteBranchConflict: { remote: string; branch: string } | null
    cacheTimerActive: boolean
  }
  review: {
    provider: string
    number: number
    title: string
    state: string | null
    /** Combined check status: `success`, `failure`, `pending` or `neutral`. */
    status: string | null
    url: string | null
  } | null
  checks: { total: number; passing: number; failing: number; pending: number }
  links: {
    /** Linked issues, pull requests and other attachments. */
    count: number
    /** A GitHub or GitLab issue is linked. */
    issue: boolean
    linearIssue: boolean
    jiraIssue: boolean
  }
  provenance: { automation: boolean; cli: boolean }
  ports: { count: number }
  lineage: { childCount: number; collapsed: boolean; toggleable: boolean }
  place: {
    isActive: boolean
    inPinnedSection: boolean
    hideRepoBadge: boolean
    showProjectName: boolean
    /** Read-only list of related workspaces (no rename, drag or menu). */
    affiliateList: boolean
    /** The delete modifier is held over a card that may be deleted. */
    deleteQuickAction: boolean
  }
  options: {
    style: WorkspaceCardStyle
    show: WorkspaceCardShowOptions
    agentRows: 'full' | 'compact'
  }
  env: { projectGroups: boolean }
  /** The workspace's agents; read only by cards that use them, so others pay nothing. */
  activity: {
    /** Orca's rolled-up status: `working`, `permission` (needs input), `done`, `active` and so on. */
    status: string
    needsInput: boolean
    counts: { working: number; blocked: number; done: number; idle: number }
    /** At most 20, newest first. */
    agents: WorkspaceCardAgentFacts[]
  }
  /** Values the card's own plugin worker set for this workspace with `cards.setFields`. */
  fields: Readonly<Record<string, string | number | boolean | null>>
  /** The person's values for the card's own declared options, defaults filled in. */
  cardOptions: Readonly<Record<string, string | number | boolean>>
}
