import type { FeatureInteractionId } from './feature-interaction-catalog'

export const FEATURE_INTERACTION_CATEGORIES = [
  'workspace',
  'agent',
  'browser',
  'launcher',
  'task_management',
  'notes',
  'review',
  'setup',
  'settings',
  'automation',
  'terminal',
  'collaboration',
  'resource_management',
  'voice',
  'source_control'
] as const
export type FeatureInteractionCategory = (typeof FEATURE_INTERACTION_CATEGORIES)[number]

export const FEATURE_INTERACTION_CATEGORY_BY_ID = {
  'workspace-board': 'workspace',
  'workspace-agent-sessions': 'workspace',
  'workspace-board-actions': 'workspace',
  'cmd-j': 'launcher',
  'cmd-j-workspace-open': 'launcher',
  'cmd-j-browser-page-open': 'launcher',
  'cmd-j-settings-open': 'launcher',
  'cmd-j-quick-action': 'launcher',
  'cmd-j-create-workspace': 'launcher',
  browser: 'browser',
  'browser-tab-created': 'browser',
  tasks: 'task_management',
  'github-tasks': 'task_management',
  'gitlab-tasks': 'task_management',
  'linear-tasks': 'task_management',
  'jira-tasks': 'task_management',
  automations: 'automation',
  'automation-created': 'automation',
  'automation-run': 'automation',
  'browser-annotations': 'browser',
  'browser-annotations-sent-to-agent': 'browser',
  'browser-grab': 'browser',
  'markdown-file-created': 'notes',
  'workspace-creation': 'workspace',
  'agent-browser-setup': 'setup',
  'agent-browser-use': 'agent',
  'agent-orchestration-setup': 'setup',
  'agent-orchestration': 'collaboration',
  'ai-commit-generation': 'source_control',
  'ai-pr-generation': 'source_control',
  'claude-account-switching': 'settings',
  'computer-use-setup': 'setup',
  'computer-use': 'agent',
  'codex-account-switching': 'settings',
  'cookie-import': 'browser',
  'floating-workspace': 'workspace',
  'floating-workspace-hidden': 'workspace',
  'mobile-pairing': 'collaboration',
  notifications: 'settings',
  ports: 'resource_management',
  'quick-commands': 'launcher',
  'resource-manager': 'resource_management',
  'review-notes': 'review',
  ssh: 'setup',
  'terminal-pane-split': 'terminal',
  'terminal-panes': 'terminal',
  'terminal-tabs': 'terminal',
  'tab-splits': 'terminal',
  'usage-tracking': 'settings',
  'voice-dictation': 'voice',
  'workspace-cleanup': 'workspace'
} as const satisfies Record<FeatureInteractionId, FeatureInteractionCategory>

export function getFeatureInteractionCategory(
  id: FeatureInteractionId
): FeatureInteractionCategory {
  return FEATURE_INTERACTION_CATEGORY_BY_ID[id]
}
