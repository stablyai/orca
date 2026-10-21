import type React from 'react'
import type NewWorkspaceComposerCard from './NewWorkspaceComposerCard'
import type { NewWorkspaceProjectOption } from '@/lib/new-workspace-project-options'

export const projectOptions: NewWorkspaceProjectOption[] = [
  {
    kind: 'project-group',
    id: 'project-group:platform',
    projectGroupId: 'platform',
    displayName: 'Platform',
    badgeColor: 'var(--muted-foreground)',
    detail: '/workspace/platform',
    parentPath: '/workspace/platform',
    connectionId: null
  }
]

/**
 * Inert defaults for every required prop, so a test names only what it exercises
 * and a new prop lands here instead of in each test file's render helper.
 */
export const defaultComposerCardProps: React.ComponentProps<typeof NewWorkspaceComposerCard> = {
  quickAgent: null,
  onQuickAgentChange: () => {},
  eligibleRepos: [],
  repoId: 'repo-a',
  projectOptions: projectOptions,
  selectedProjectId: 'project-group:platform',
  selectedRepoIsGit: true,
  onRepoChange: () => {},
  onProjectChange: () => {},
  primaryActionLabel: 'Create workspace',
  name: '',
  onNameValueChange: () => {},
  onSmartGitHubItemSelect: () => {},
  onSmartGitLabItemSelect: () => {},
  onSmartBranchSelect: () => {},
  onSmartLinearIssueSelect: () => {},
  smartNameSelection: null,
  onClearSmartNameSelection: () => {},
  canReuseSelectedBranch: false,
  reuseSelectedBranch: false,
  onReuseSelectedBranchChange: () => {},
  branchNameOverride: '',
  onBranchNameOverrideChange: () => {},
  parentWorktreeId: null,
  onParentWorktreeIdChange: () => {},
  forkPushWarning: null,
  detectedAgentIds: null,
  onOpenAgentSettings: () => {},
  advancedOpen: false,
  onToggleAdvanced: () => {},
  createDisabled: false,
  projectError: null,
  creating: false,
  onCreate: () => {},
  note: '',
  onNoteChange: () => {},
  tags: [],
  onTagsChange: () => {},
  tagDraft: '',
  onTagDraftChange: () => {},
  setupConfig: null,
  requiresExplicitSetupChoice: false,
  setupDecision: null,
  onSetupDecisionChange: () => {},
  setupAgentStartupPolicy: 'start-immediately',
  onSetupAgentStartupPolicyChange: () => {},
  shouldWaitForSetupCheck: false,
  resolvedSetupDecision: null,
  createError: null,
  selectedRepoConnectionId: null,
  selectedRepoSshStatus: null,
  selectedRepoRequiresConnection: false,
  selectedRepoConnectInProgress: false,
  onConnectSelectedRepo: async () => {},
  canUseSparseCheckout: false,
  sparsePresets: [],
  sparseSelectedPresetId: null,
  onSparseSelectPreset: () => {},
  branchesEnabled: false,
  setupControlsEnabled: false,
  sparseControlsEnabled: false
}
