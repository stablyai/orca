import type { SettingsSearchEntry } from './settings-search'

export const ACCOUNTS_CLAUDE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Claude Accounts',
    description: 'Manage which Claude account Orca uses while preserving shared chat context.',
    keywords: ['claude', 'account', 'switch', 'active', 'status bar', 'quota']
  }
]

export const ACCOUNTS_CODEX_SEARCH_ENTRIES: SettingsSearchEntry[] = [
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

export const ACCOUNTS_GEMINI_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Use Gemini CLI credentials',
    description:
      'Extracts OAuth credentials from your local Gemini CLI installation to authenticate with Google.',
    keywords: ['gemini', 'cli', 'oauth', 'credentials', 'experimental', 'rate limit', 'status bar']
  }
]

export const ACCOUNTS_OPENCODE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'OpenCode Go Session Cookie',
    description: 'Paste your opencode.ai session cookie for rate limit fetching.',
    keywords: ['opencode', 'cookie', 'session', 'rate limit', 'status bar']
  },
  {
    title: 'OpenCode Go Workspace ID',
    description: 'Optional workspace ID override if the automatic lookup fails.',
    keywords: ['opencode', 'workspace', 'id', 'wrk', 'rate limit', 'status bar']
  }
]

export const ACCOUNTS_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  ...ACCOUNTS_CLAUDE_SEARCH_ENTRIES,
  ...ACCOUNTS_CODEX_SEARCH_ENTRIES,
  ...ACCOUNTS_GEMINI_SEARCH_ENTRIES,
  ...ACCOUNTS_OPENCODE_SEARCH_ENTRIES
]
