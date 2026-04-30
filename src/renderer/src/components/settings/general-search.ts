import type { SettingsSearchEntry } from './settings-search'

export const GENERAL_WORKSPACE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Workspace Directory',
    description: 'Root directory where worktree folders are created.',
    keywords: ['workspace', 'folder', 'path', 'worktree']
  },
  {
    title: 'Nest Workspaces',
    description: 'Create worktrees inside a repo-named subfolder.',
    keywords: ['nested', 'subfolder', 'directory']
  },
  {
    title: 'Skip Delete Worktree Confirmation',
    description: 'Delete worktrees from the context menu without a confirmation dialog.',
    keywords: ['delete', 'worktree', 'confirm', 'dialog', 'skip', 'prompt']
  }
]

export const GENERAL_EDITOR_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Auto Save Files',
    description: 'Save editor and editable diff changes automatically after a short pause.',
    keywords: ['autosave', 'save']
  },
  {
    title: 'Auto Save Delay',
    description: 'How long Orca waits after your last edit before saving automatically.',
    keywords: ['autosave', 'delay', 'milliseconds']
  },
  {
    title: 'Default Diff View',
    description: 'Preferred presentation format for showing git diffs by default.',
    keywords: ['diff', 'view', 'inline', 'side-by-side', 'split']
  }
]

export const GENERAL_CLI_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Shell command',
    description: 'Register or remove the orca shell command.',
    keywords: ['cli', 'path', 'terminal', 'command']
  },
  {
    title: 'Agent skill',
    description: 'Install the Orca skill so agents know to use the orca CLI.',
    keywords: ['skill', 'agents', 'npx']
  }
]

export const GENERAL_UPDATE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Check for Updates',
    description: 'Check for app updates and install a newer Orca version.',
    keywords: ['update', 'version', 'release notes', 'download']
  }
]

export const GENERAL_CACHE_TIMER_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Prompt Cache Timer',
    description: 'Countdown timer showing time until prompt cache expires (Claude agents).',
    keywords: ['cache', 'timer', 'prompt', 'ttl', 'claude', 'cost', 'tokens']
  }
]

export const GENERAL_AGENT_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Default Agent',
    description: 'Pre-select an AI coding agent in the new-workspace composer.',
    keywords: [
      'agent',
      'default',
      'claude',
      'codex',
      'opencode',
      'pi',
      'gemini',
      'aider',
      'copilot'
    ]
  }
]

export const GENERAL_SUPPORT_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Star Orca on GitHub',
    description: 'Support the project with a GitHub star via the gh CLI.',
    keywords: ['star', 'github', 'support', 'feedback', 'like']
  }
]

export const GENERAL_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  ...GENERAL_WORKSPACE_SEARCH_ENTRIES,
  ...GENERAL_EDITOR_SEARCH_ENTRIES,
  ...GENERAL_CLI_SEARCH_ENTRIES,
  ...GENERAL_CACHE_TIMER_SEARCH_ENTRIES,
  ...GENERAL_UPDATE_SEARCH_ENTRIES,
  ...GENERAL_SUPPORT_SEARCH_ENTRIES
]
