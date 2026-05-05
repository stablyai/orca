import type { SettingsSearchEntry } from './settings-search'

export const BROWSER_USE_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Enable Orca CLI',
    description: 'Register the orca shell command so agents can drive the browser.',
    keywords: ['browser use', 'cli', 'orca', 'path', 'command', 'shell', 'enable', 'setup']
  },
  {
    title: 'Install Browser Use Skill',
    description: 'Install the orca-cli agent skill so agents know how to use the browser.',
    keywords: [
      'browser use',
      'skill',
      'agent',
      'install',
      'orca-cli',
      'npx',
      'agent-browser',
      'automation'
    ]
  },
  {
    title: 'Import Browser Cookies',
    description:
      'Import cookies from Chrome, Edge, or other browsers so agents can reuse your logins.',
    keywords: [
      'browser use',
      'cookies',
      'session',
      'import',
      'login',
      'auth',
      'chrome',
      'edge',
      'arc'
    ]
  }
]
