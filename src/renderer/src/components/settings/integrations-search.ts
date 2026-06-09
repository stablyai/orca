import type { SettingsSearchEntry } from './settings-search'

export const INTEGRATIONS_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'GitHub Integration',
    description: 'GitHub authentication via the gh CLI.',
    keywords: ['github', 'gh', 'integration']
  },
  {
    title: 'GitLab Integration',
    description: 'GitLab authentication via the glab CLI.',
    keywords: ['gitlab', 'glab', 'integration', 'mr', 'merge request']
  },
  {
    title: 'Bitbucket Integration',
    description: 'Bitbucket Cloud authentication via API token environment variables.',
    keywords: ['bitbucket', 'integration', 'pull request', 'api token']
  },
  {
    title: 'Azure DevOps Integration',
    description: 'Azure DevOps Repos authentication via token environment variables.',
    keywords: ['azure devops', 'azure repos', 'ado', 'integration', 'pull request', 'api token']
  },
  {
    title: 'Gitea Integration',
    description: 'Gitea authentication via API token environment variables.',
    keywords: ['gitea', 'self-hosted', 'integration', 'pull request', 'api token']
  },
  {
    title: 'Jira Integration',
    description: 'Connect Jira Cloud or update Jira API token credentials.',
    keywords: [
      'jira',
      'atlassian',
      'integration',
      'api token',
      'credentials',
      'connect',
      'disconnect'
    ]
  },
  {
    title: 'Linear Integration',
    description: 'Connect Linear to browse and link issues.',
    keywords: ['linear', 'integration', 'api key', 'connect', 'disconnect']
  }
]
