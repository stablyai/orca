import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getIntegrationsPaneSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate(
      'auto.components.settings.integrations.search.f16e41cc72',
      'GitHub Integration'
    ),
    description: translate(
      'auto.components.settings.integrations.search.7166b9090c',
      'GitHub authentication via the gh CLI.'
    ),
    keywords: [
      translate('auto.components.settings.integrations.search.b79c21bd42', 'github'),
      translate('auto.components.settings.integrations.search.41ccade05c', 'gh'),
      translate('auto.components.settings.integrations.search.c450244ad7', 'integration')
    ]
  },
  {
    title: translate(
      'auto.components.settings.integrations.search.b50b71ef9d',
      'GitLab Integration'
    ),
    description: translate(
      'auto.components.settings.integrations.search.6e2ab619c6',
      'GitLab authentication via the glab CLI.'
    ),
    keywords: [
      translate('auto.components.settings.integrations.search.b939695c69', 'gitlab'),
      translate('auto.components.settings.integrations.search.b40cbe5de4', 'glab'),
      translate('auto.components.settings.integrations.search.c450244ad7', 'integration'),
      translate('auto.components.settings.integrations.search.581844769a', 'mr'),
      translate('auto.components.settings.integrations.search.371ee914d2', 'merge request')
    ]
  },
  {
    title: translate(
      'auto.components.settings.integrations.search.67a2a0e868',
      'Bitbucket Integration'
    ),
    description: translate(
      'auto.components.settings.integrations.search.c97d58a0f3',
      'Bitbucket Cloud authentication via API token environment variables.'
    ),
    keywords: [
      translate('auto.components.settings.integrations.search.50d20817f7', 'bitbucket'),
      translate('auto.components.settings.integrations.search.c450244ad7', 'integration'),
      translate('auto.components.settings.integrations.search.8c568d761c', 'pull request'),
      translate('auto.components.settings.integrations.search.2ec2bd328c', 'api token')
    ]
  },
  {
    title: translate(
      'auto.components.settings.integrations.search.af6611fa6e',
      'Azure DevOps Integration'
    ),
    description: translate(
      'auto.components.settings.integrations.search.7b1f3984bb',
      'Azure DevOps Repos authentication via token environment variables.'
    ),
    keywords: [
      translate('auto.components.settings.integrations.search.b38b5d27f1', 'azure devops'),
      translate('auto.components.settings.integrations.search.ed63380247', 'azure repos'),
      translate('auto.components.settings.integrations.search.03a7b275be', 'ado'),
      translate('auto.components.settings.integrations.search.c450244ad7', 'integration'),
      translate('auto.components.settings.integrations.search.8c568d761c', 'pull request'),
      translate('auto.components.settings.integrations.search.2ec2bd328c', 'api token')
    ]
  },
  {
    title: translate(
      'auto.components.settings.integrations.search.aab86d64e5',
      'Gitea Integration'
    ),
    description: translate(
      'auto.components.settings.integrations.search.d0d019dc29',
      'Gitea authentication via API token environment variables.'
    ),
    keywords: [
      translate('auto.components.settings.integrations.search.129fc59aa8', 'gitea'),
      translate('auto.components.settings.integrations.search.33180e8c10', 'self-hosted'),
      translate('auto.components.settings.integrations.search.c450244ad7', 'integration'),
      translate('auto.components.settings.integrations.search.8c568d761c', 'pull request'),
      translate('auto.components.settings.integrations.search.2ec2bd328c', 'api token')
    ]
  },
  {
    title: translate('auto.components.settings.integrations.search.617603509b', 'Jira Integration'),
    description: translate(
      'auto.components.settings.integrations.search.76f6af7c57',
      'Connect Jira Cloud or update Jira API token credentials.'
    ),
    keywords: [
      translate('auto.components.settings.integrations.search.e1263dd748', 'jira'),
      translate('auto.components.settings.integrations.search.7345b7c3e6', 'atlassian'),
      translate('auto.components.settings.integrations.search.c450244ad7', 'integration'),
      translate('auto.components.settings.integrations.search.2ec2bd328c', 'api token'),
      translate('auto.components.settings.integrations.search.20540996ef', 'credentials'),
      translate('auto.components.settings.integrations.search.3c3d3d8ffa', 'connect'),
      translate('auto.components.settings.integrations.search.a626990bd2', 'disconnect')
    ]
  },
  {
    title: translate(
      'auto.components.settings.integrations.search.b027b4b318',
      'Linear Integration'
    ),
    description: translate(
      'auto.components.settings.integrations.search.16a486a49d',
      'Connect Linear to browse and link issues.'
    ),
    keywords: [
      translate('auto.components.settings.integrations.search.7319e3015b', 'linear'),
      translate('auto.components.settings.integrations.search.c450244ad7', 'integration'),
      translate('auto.components.settings.integrations.search.faa0b5a0d9', 'api key'),
      translate('auto.components.settings.integrations.search.3c3d3d8ffa', 'connect'),
      translate('auto.components.settings.integrations.search.a626990bd2', 'disconnect')
    ]
  }
])
