export type FeatureInteractionId =
  | 'workspace-board'
  | 'workspace-agent-sessions'
  | 'workspace-board-actions'
  | 'cmd-j'
  | 'cmd-j-workspace-open'
  | 'cmd-j-browser-page-open'
  | 'cmd-j-settings-open'
  | 'cmd-j-quick-action'
  | 'cmd-j-create-workspace'
  | 'browser'
  | 'browser-tab-created'
  | 'tasks'
  | 'github-tasks'
  | 'gitlab-tasks'
  | 'linear-tasks'
  | 'jira-tasks'
  | 'automations'
  | 'automation-created'
  | 'automation-run'
  | 'browser-annotations'
  | 'browser-annotations-sent-to-agent'
  | 'browser-grab'
  | 'markdown-file-created'
  | 'workspace-creation'
  | 'agent-browser-setup'
  | 'agent-browser-use'
  | 'agent-orchestration-setup'
  | 'agent-orchestration'
  | 'ephemeral-vm-setup'
  | 'mobile-emulator-agent-setup'
  | 'ai-commit-generation'
  | 'ai-pr-generation'
  | 'claude-account-switching'
  | 'computer-use-setup'
  | 'computer-use'
  | 'codex-account-switching'
  | 'cookie-import'
  | 'floating-workspace'
  | 'floating-workspace-hidden'
  | 'mobile-pairing'
  | 'notifications'
  | 'ports'
  | 'quick-commands'
  | 'resource-manager'
  | 'review-notes'
  | 'ssh'
  | 'terminal-pane-split'
  | 'terminal-panes'
  | 'terminal-tabs'
  | 'tab-splits'
  | 'usage-tracking'
  | 'voice-dictation'
  | 'workspace-cleanup'

export type FeatureInteractionDefinition = {
  id: FeatureInteractionId
  /** The product action that counts as "the user has interacted with this feature." */
  interaction: string
}

// Why: these ids become persisted product state; changing them breaks
// feature-discovery interaction tracking.
export const FEATURE_INTERACTIONS = [
  { id: 'workspace-board', interaction: 'workspace board opened' },
  {
    id: 'workspace-agent-sessions',
    interaction: 'workspace agent-session surface opened'
  },
  {
    id: 'workspace-board-actions',
    interaction: 'workspace board card, lane, density, or status action used'
  },
  { id: 'cmd-j', interaction: 'Cmd+J palette opened' },
  { id: 'cmd-j-workspace-open', interaction: 'workspace opened from Cmd+J' },
  { id: 'cmd-j-browser-page-open', interaction: 'browser page opened from Cmd+J' },
  { id: 'cmd-j-settings-open', interaction: 'settings opened from Cmd+J' },
  { id: 'cmd-j-quick-action', interaction: 'quick action run from Cmd+J' },
  { id: 'cmd-j-create-workspace', interaction: 'workspace creation started from Cmd+J' },
  { id: 'browser', interaction: 'in-app browser opened' },
  { id: 'browser-tab-created', interaction: 'browser tab explicitly created' },
  { id: 'tasks', interaction: 'Tasks page opened' },
  { id: 'github-tasks', interaction: 'GitHub task item workflow used' },
  { id: 'gitlab-tasks', interaction: 'GitLab task item workflow used' },
  { id: 'linear-tasks', interaction: 'Linear task item workflow used' },
  { id: 'jira-tasks', interaction: 'Jira task item workflow used' },
  { id: 'automations', interaction: 'Automations page opened' },
  { id: 'automation-created', interaction: 'automation created' },
  { id: 'automation-run', interaction: 'automation run queued' },
  { id: 'browser-annotations', interaction: 'browser annotation added, copied, or cleared' },
  {
    id: 'browser-annotations-sent-to-agent',
    interaction: 'browser annotations sent to an agent'
  },
  { id: 'browser-grab', interaction: 'browser element grab or screenshot used' },
  { id: 'markdown-file-created', interaction: 'untitled markdown file explicitly created' },
  { id: 'workspace-creation', interaction: 'workspace creation flow opened' },
  { id: 'agent-browser-setup', interaction: 'Agent Browser Use setup enabled or opened' },
  { id: 'agent-browser-use', interaction: 'agent browser runtime method used' },
  { id: 'ephemeral-vm-setup', interaction: 'Ephemeral VMs setup opened or scaffold prompt copied' },
  {
    id: 'agent-orchestration-setup',
    interaction: 'Agent Orchestration setup enabled or opened'
  },
  { id: 'agent-orchestration', interaction: 'agent orchestration runtime method used' },
  {
    id: 'mobile-emulator-agent-setup',
    interaction: 'Mobile Emulator agent CLI or skill setup opened'
  },
  {
    id: 'ai-commit-generation',
    interaction: 'AI commit message generation enabled or used'
  },
  { id: 'ai-pr-generation', interaction: 'AI pull request generation used' },
  {
    id: 'claude-account-switching',
    interaction: 'Claude managed account added, selected, reauthenticated, or removed'
  },
  {
    id: 'computer-use-setup',
    interaction: 'Computer Use setup or permission flow opened'
  },
  { id: 'computer-use', interaction: 'computer-use runtime method used' },
  {
    id: 'codex-account-switching',
    interaction: 'Codex managed account added, selected, reauthenticated, or removed'
  },
  { id: 'cookie-import', interaction: 'browser cookies imported or cleared' },
  { id: 'floating-workspace', interaction: 'Floating Workspace opened or configured' },
  {
    id: 'floating-workspace-hidden',
    interaction: 'Floating Workspace explicitly hidden or disabled'
  },
  { id: 'mobile-pairing', interaction: 'mobile pairing enabled or QR code generated' },
  { id: 'notifications', interaction: 'desktop notifications enabled or tested' },
  { id: 'ports', interaction: 'Ports popover opened, configured, or port action used' },
  { id: 'quick-commands', interaction: 'terminal quick command created or edited' },
  { id: 'resource-manager', interaction: 'Resource Manager opened or configured' },
  { id: 'review-notes', interaction: 'review note added or sent to an agent' },
  {
    id: 'ssh',
    interaction: 'SSH target added, imported, tested, connected, disconnected, or configured'
  },
  {
    id: 'terminal-pane-split',
    interaction: 'terminal pane split from the split-pane command'
  },
  {
    id: 'terminal-panes',
    interaction: 'terminal/editor/browser pane created, resized, or merged'
  },
  {
    id: 'terminal-tabs',
    interaction: 'workspace tab created, moved, reordered, pinned, renamed, recolored, or closed'
  },
  { id: 'tab-splits', interaction: 'workspace tab split into another pane' },
  {
    id: 'usage-tracking',
    interaction: 'Stats & Usage or provider usage details opened or configured'
  },
  { id: 'voice-dictation', interaction: 'dictation session started' },
  {
    id: 'workspace-cleanup',
    interaction: 'workspace disk space scan, review, or cleanup action used'
  }
] as const satisfies readonly FeatureInteractionDefinition[]

export const FEATURE_INTERACTION_IDS = FEATURE_INTERACTIONS.map((feature) => feature.id) as [
  FeatureInteractionId,
  ...FeatureInteractionId[]
]
