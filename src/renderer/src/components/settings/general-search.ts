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

export const GENERAL_BRANCH_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Branch Prefix',
    description: 'Prefix added to branch names when creating worktrees.',
    keywords: ['branch naming', 'git username', 'custom']
  }
]

export const GENERAL_UPDATE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Check for Updates',
    description: 'Check for app updates and install a newer Orca version.',
    keywords: ['update', 'version', 'release notes', 'download']
  }
]

export const GENERAL_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  ...GENERAL_WORKSPACE_SEARCH_ENTRIES,
  ...GENERAL_EDITOR_SEARCH_ENTRIES,
  ...GENERAL_CLI_SEARCH_ENTRIES,
  ...GENERAL_BRANCH_SEARCH_ENTRIES,
  ...GENERAL_UPDATE_SEARCH_ENTRIES
]
