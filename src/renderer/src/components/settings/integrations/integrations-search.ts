import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from '../search/settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

// Provider rows carry these ids so search results can scroll to and highlight them.
export const INTEGRATION_SETTING_TARGET_IDS = {
  github: 'integrations-github',
  gitlab: 'integrations-gitlab',
  bitbucket: 'integrations-bitbucket',
  azuredevops: 'integrations-azure-devops',
  gitea: 'integrations-gitea',
  jira: 'integrations-jira',
  linear: 'integrations-linear'
} as const

export const getIntegrationsPaneSearchEntries = createLocalizedCatalog(() => [
  {
    targetSectionId: INTEGRATION_SETTING_TARGET_IDS.github,
    title: translate(
      'auto.components.settings.integrations.search.a17a94d0b0',
      'GitHub integration'
    ),
    description: translate(
      'auto.components.settings.integrations.search.7166b9090c',
      'GitHub authentication via the gh CLI.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.integrations.search.b79c21bd42',
        'github'
      ),
      ...translateSearchKeyword('auto.components.settings.integrations.search.41ccade05c', 'gh'),
      ...translateSearchKeyword(
        'auto.components.settings.integrations.search.c450244ad7',
        'integration'
      )
    ]
  },
  {
    targetSectionId: INTEGRATION_SETTING_TARGET_IDS.gitlab,
    title: translate(
      'auto.components.settings.integrations.search.cd74b2f587',
      'GitLab integration'
    ),
    description: translate(
      'auto.components.settings.integrations.search.6e2ab619c6',
      'GitLab authentication via the glab CLI.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.integrations.search.b939695c69',
        'gitlab'
      ),
      ...translateSearchKeyword('auto.components.settings.integrations.search.b40cbe5de4', 'glab'),
      ...translateSearchKeyword(
        'auto.components.settings.integrations.search.c450244ad7',
        'integration'
      ),
      ...translateSearchKeyword('auto.components.settings.integrations.search.581844769a', 'mr'),
      ...translateSearchKeyword(
        'auto.components.settings.integrations.search.371ee914d2',
        'merge request'
      )
    ]
  },
  {
    targetSectionId: INTEGRATION_SETTING_TARGET_IDS.bitbucket,
    title: translate(
      'auto.components.settings.integrations.search.9e238582e8',
      'Bitbucket integration'
    ),
    description: translate(
      'auto.components.settings.integrations.search.760e2446e0',
      'Bitbucket Cloud authentication with a saved API token or environment variables.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.integrations.search.50d20817f7',
        'bitbucket'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.integrations.search.c450244ad7',
        'integration'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.integrations.search.8c568d761c',
        'pull request'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.integrations.search.2ec2bd328c',
        'api token'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.integrations.search.3c3d3d8ffa',
        'connect'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.integrations.search.a626990bd2',
        'disconnect'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.integrations.search.20540996ef',
        'credentials'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.integrations.search.af5ae87847',
        'access token'
      )
    ]
  },
  {
    targetSectionId: INTEGRATION_SETTING_TARGET_IDS.azuredevops,
    title: translate(
      'auto.components.settings.integrations.search.b3efe7ab71',
      'Azure DevOps integration'
    ),
    description: translate(
      'auto.components.settings.integrations.search.7b1f3984bb',
      'Azure DevOps Repos authentication via token environment variables.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.integrations.search.b38b5d27f1',
        'azure devops'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.integrations.search.ed63380247',
        'azure repos'
      ),
      ...translateSearchKeyword('auto.components.settings.integrations.search.03a7b275be', 'ado'),
      ...translateSearchKeyword(
        'auto.components.settings.integrations.search.c450244ad7',
        'integration'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.integrations.search.8c568d761c',
        'pull request'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.integrations.search.2ec2bd328c',
        'api token'
      )
    ]
  },
  {
    targetSectionId: INTEGRATION_SETTING_TARGET_IDS.gitea,
    title: translate(
      'auto.components.settings.integrations.search.86a08aa60c',
      'Gitea integration'
    ),
    description: translate(
      'auto.components.settings.integrations.search.d0d019dc29',
      'Gitea authentication via API token environment variables.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.integrations.search.129fc59aa8', 'gitea'),
      ...translateSearchKeyword(
        'auto.components.settings.integrations.search.33180e8c10',
        'self-hosted'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.integrations.search.c450244ad7',
        'integration'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.integrations.search.8c568d761c',
        'pull request'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.integrations.search.2ec2bd328c',
        'api token'
      )
    ]
  },
  {
    targetSectionId: INTEGRATION_SETTING_TARGET_IDS.jira,
    title: translate('auto.components.settings.integrations.search.d8906d60a9', 'Jira integration'),
    description: translate(
      'auto.components.settings.integrations.search.76f6af7c57',
      'Connect Jira Cloud or update Jira API token credentials.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.integrations.search.e1263dd748', 'jira'),
      ...translateSearchKeyword(
        'auto.components.settings.integrations.search.7345b7c3e6',
        'atlassian'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.integrations.search.c450244ad7',
        'integration'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.integrations.search.2ec2bd328c',
        'api token'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.integrations.search.20540996ef',
        'credentials'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.integrations.search.3c3d3d8ffa',
        'connect'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.integrations.search.a626990bd2',
        'disconnect'
      )
    ]
  },
  {
    targetSectionId: INTEGRATION_SETTING_TARGET_IDS.linear,
    title: translate(
      'auto.components.settings.integrations.search.d905b3ecee',
      'Linear integration'
    ),
    description: translate(
      'auto.components.settings.integrations.search.16a486a49d',
      'Connect Linear to browse and link issues.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.integrations.search.7319e3015b',
        'linear'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.integrations.search.c450244ad7',
        'integration'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.integrations.search.faa0b5a0d9',
        'api key'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.integrations.search.3c3d3d8ffa',
        'connect'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.integrations.search.a626990bd2',
        'disconnect'
      )
    ]
  }
])
