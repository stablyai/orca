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
    title: 'Enable GitHub Tasks',
    description: 'Show GitHub issues and PRs in the task pane on the new workspace page.',
    keywords: ['tasks', 'github', 'issues', 'prs', 'pane', 'hide', 'show', 'new workspace']
  },
  {
    title: 'Enable Linear Tasks',
    description: 'Show Linear issues in the task pane on the new workspace page.',
    keywords: ['tasks', 'linear', 'issues', 'pane', 'hide', 'show', 'new workspace']
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

export const GENERAL_BROWSER_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Default Home Page',
    description: 'URL opened when creating a new browser tab. Leave empty to open a blank tab.',
    keywords: ['browser', 'home', 'homepage', 'default', 'url', 'new tab', 'blank', 'landing']
  },
  {
    title: 'Terminal Link Routing',
    description:
      'Cmd/Ctrl+click opens terminal http(s) links in Orca. Shift+Cmd/Ctrl+click uses the system browser.',
    keywords: ['browser', 'preview', 'links', 'localhost', 'webview', 'shift', 'cmd', 'ctrl']
  },
  {
    title: 'Session & Cookies',
    description:
      'Import cookies from Chrome, Edge, or other browsers to use existing logins inside Orca.',
    keywords: [
      'browser',
      'cookies',
      'session',
      'import',
      'auth',
      'login',
      'chrome',
      'edge',
      'arc',
      'profile'
    ]
  }
]

export const GENERAL_CODEX_ACCOUNTS_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Codex Accounts',
    description: 'Manage which Codex account Orca uses for live rate limit fetching.',
    keywords: ['codex', 'account', 'rate limit', 'status bar', 'quota']
  },
  {
    title: 'Active Codex Account',
    description: 'Choose which saved Codex account powers live quota reads.',
    keywords: ['codex', 'account', 'switch', 'active', 'status bar']
  }
]

export const GENERAL_AGENT_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Default Agent',
    description: 'Pre-select an AI coding agent in the new-workspace composer.',
    keywords: ['agent', 'default', 'claude', 'codex', 'opencode', 'pi', 'gemini', 'aider']
  }
]

export const GENERAL_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  ...GENERAL_WORKSPACE_SEARCH_ENTRIES,
  ...GENERAL_BROWSER_SEARCH_ENTRIES,
  ...GENERAL_EDITOR_SEARCH_ENTRIES,
  ...GENERAL_CLI_SEARCH_ENTRIES,
  ...GENERAL_CACHE_TIMER_SEARCH_ENTRIES,
  ...GENERAL_CODEX_ACCOUNTS_SEARCH_ENTRIES,
  ...GENERAL_UPDATE_SEARCH_ENTRIES
]
