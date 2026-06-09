import type { SettingsSearchEntry } from './settings-search'
import { getGeneralEditorSearchEntries } from './general-editor-search'
import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export { getGeneralEditorSearchEntries } from './general-editor-search'

export const getGeneralWorkspaceSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.general.search.4c95d08fa2', 'Workspace Directory'),
    description: translate(
      'auto.components.settings.general.search.d0bc793689',
      'Root directory where workspace folders are created.'
    ),
    keywords: [
      translate('auto.components.settings.general.search.7baf524b04', 'workspace'),
      translate('auto.components.settings.general.search.7887a2c262', 'folder'),
      translate('auto.components.settings.general.search.fb4f338a3d', 'path'),
      translate('auto.components.settings.general.search.df10666259', 'worktree')
    ]
  },
  {
    title: translate('auto.components.settings.general.search.141f71c69f', 'Nest Workspaces'),
    description: translate(
      'auto.components.settings.general.search.b9cffd374d',
      'Create workspaces inside a repo-named subfolder.'
    ),
    keywords: [
      translate('auto.components.settings.general.search.ec5049e510', 'nested'),
      translate('auto.components.settings.general.search.9bde064915', 'subfolder'),
      translate('auto.components.settings.general.search.93f6ec5e70', 'directory')
    ]
  },
  {
    title: translate(
      'auto.components.settings.general.search.913242091d',
      'Ask Before Deleting Workspaces'
    ),
    description: translate(
      'auto.components.settings.general.search.ae98c9cf36',
      'Show a confirmation dialog before deleting a workspace.'
    ),
    keywords: [
      translate('auto.components.settings.general.search.84c67d0108', 'delete'),
      translate('auto.components.settings.general.search.df10666259', 'worktree'),
      translate('auto.components.settings.general.search.9f8558233a', 'confirm'),
      translate('auto.components.settings.general.search.ca86dd6e27', 'dialog'),
      translate('auto.components.settings.general.search.7e9b556873', 'skip'),
      translate('auto.components.settings.general.search.0efc9d96ad', 'prompt')
    ]
  },
  {
    title: translate(
      'auto.components.settings.general.search.d0a65b27fd',
      'Ask Before Deleting Automations'
    ),
    description: translate(
      'auto.components.settings.general.search.a0c44061ee',
      'Show a confirmation dialog before deleting an automation and its run history.'
    ),
    keywords: [
      translate('auto.components.settings.general.search.84c67d0108', 'delete'),
      translate('auto.components.settings.general.search.7edf4f69e2', 'automation'),
      translate('auto.components.settings.general.search.9f8558233a', 'confirm'),
      translate('auto.components.settings.general.search.ca86dd6e27', 'dialog'),
      translate('auto.components.settings.general.search.7e9b556873', 'skip'),
      translate('auto.components.settings.general.search.0efc9d96ad', 'prompt')
    ]
  },
  {
    title: translate('auto.components.settings.general.search.451d4af994', 'Open In Apps'),
    description: translate(
      'auto.components.settings.general.search.a916662068',
      "Choose apps available from a workspace's Open in menu."
    ),
    keywords: [
      translate('auto.components.settings.general.search.b8093e9a93', 'open in'),
      translate('auto.components.settings.general.search.5a9df5566f', 'open menu'),
      translate('auto.components.settings.general.search.e1ee631696', 'editor'),
      translate('auto.components.settings.general.search.8fb00fcd05', 'launcher'),
      translate('auto.components.settings.general.search.0cb3d94f00', 'cursor'),
      translate('auto.components.settings.general.search.ebf8f056b5', 'zed'),
      translate('auto.components.settings.general.search.dbeb1f348e', 'command'),
      translate('auto.components.settings.general.search.68d03d9980', 'vscode'),
      translate('auto.components.settings.general.search.c9d9636f24', 'finder'),
      translate('auto.components.settings.general.search.6c2ce8457c', 'file explorer')
    ]
  }
])

export const getGeneralNetworkSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.general.search.c29f23ab57', 'HTTP Proxy'),
    description: translate(
      'auto.components.settings.general.search.e3b1d42f95',
      'Proxy URL for Orca network requests and local terminal children.'
    ),
    keywords: [
      translate('auto.components.settings.general.search.20b711ac9e', 'proxy'),
      translate('auto.components.settings.general.search.8f03d44672', 'http_proxy'),
      translate('auto.components.settings.general.search.b9096a44cf', 'https_proxy'),
      translate('auto.components.settings.general.search.c56cb6f1c2', 'network'),
      translate('auto.components.settings.general.search.9da6c875e5', 'dock'),
      translate('auto.components.settings.general.search.e55d62dfa4', 'launchpad')
    ]
  },
  {
    title: translate('auto.components.settings.general.search.8436ff6f8e', 'Proxy Bypass Rules'),
    description: translate(
      'auto.components.settings.general.search.eb8946b2c9',
      'Hosts that should bypass the configured HTTP proxy.'
    ),
    keywords: [
      translate('auto.components.settings.general.search.20b711ac9e', 'proxy'),
      translate('auto.components.settings.general.search.3a73054565', 'bypass'),
      translate('auto.components.settings.general.search.91a46caafc', 'no_proxy'),
      translate('auto.components.settings.general.search.3566fce83f', 'localhost'),
      translate('auto.components.settings.general.search.c56cb6f1c2', 'network')
    ]
  }
])

export const getGeneralNavigationSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.general.search.256d92554d', 'Tab Order'),
    description: translate(
      'auto.components.settings.general.search.e53d585ed6',
      'Recent or tab strip.'
    ),
    keywords: [
      translate('auto.components.settings.general.search.ca812803ea', 'recent tab order'),
      translate('auto.components.settings.general.search.2a254b725e', 'tab'),
      translate('auto.components.settings.general.search.fe62b3f09f', 'ctrl'),
      translate('auto.components.settings.general.search.750420dd9a', 'control'),
      translate('auto.components.settings.general.search.54ba13831a', 'recent'),
      translate('auto.components.settings.general.search.12ecc640a8', 'mru'),
      translate('auto.components.settings.general.search.f8f0ac213a', 'sequential'),
      translate('auto.components.settings.general.search.fb84767421', 'switch')
    ]
  }
])

export const getGeneralCliSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.general.search.327e3fa70d', 'Orca CLI'),
    description: translate(
      'auto.components.settings.general.search.ca529079bf',
      'Register or remove the Orca CLI command.'
    ),
    keywords: [
      translate('auto.components.settings.general.search.924a660a78', 'cli'),
      translate('auto.components.settings.general.search.fb4f338a3d', 'path'),
      translate('auto.components.settings.general.search.88d3df9ce9', 'terminal'),
      translate('auto.components.settings.general.search.dbeb1f348e', 'command'),
      translate('auto.components.settings.general.search.0a00691c06', 'shell command')
    ],
    cmdJKeywords: ['cli', 'path', 'command', 'shell command'],
    targetSectionId: 'cli'
  },
  {
    title: translate('auto.components.settings.general.search.2d9f7b42df', 'Agent skill'),
    description: translate(
      'auto.components.settings.general.search.244e3fb4c8',
      'Install the Orca skill so agents know to use the Orca CLI.'
    ),
    keywords: [
      translate('auto.components.settings.general.search.bda108e66c', 'skill'),
      translate('auto.components.settings.general.search.baa263d6d8', 'agents'),
      translate('auto.components.settings.general.search.6382fe9724', 'npx')
    ]
  }
])

export const getGeneralUpdateSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.general.search.e15af4eb64', 'Check for Updates'),
    description: translate(
      'auto.components.settings.general.search.79ff46776e',
      'Check for app updates and install a newer Orca version.'
    ),
    keywords: [
      translate('auto.components.settings.general.search.f89a94773c', 'update'),
      translate('auto.components.settings.general.search.9e86ccd05c', 'version'),
      translate('auto.components.settings.general.search.c9d8c1ce66', 'release notes'),
      translate('auto.components.settings.general.search.e49e739a59', 'download')
    ]
  }
])

export const getGeneralCacheTimerSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.general.search.1e0f28c6f1', 'Prompt Cache Timer'),
    description: translate(
      'auto.components.settings.general.search.40c9585e43',
      'Countdown timer showing time until prompt cache expires (Claude agents).'
    ),
    keywords: [
      translate('auto.components.settings.general.search.b2601a778c', 'cache'),
      translate('auto.components.settings.general.search.939b80f5fd', 'timer'),
      translate('auto.components.settings.general.search.0efc9d96ad', 'prompt'),
      translate('auto.components.settings.general.search.585beac3f8', 'ttl'),
      translate('auto.components.settings.general.search.95b63edde7', 'claude'),
      translate('auto.components.settings.general.search.660528b048', 'cost'),
      translate('auto.components.settings.general.search.3462308bd3', 'tokens')
    ]
  }
])

export const getGeneralAgentSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.general.search.db11502270', 'Default Agent'),
    description: translate(
      'auto.components.settings.general.search.e2da948f59',
      'Pre-select an AI coding agent in the new-workspace composer.'
    ),
    keywords: [
      translate('auto.components.settings.general.search.8ea37a05bc', 'agent'),
      translate('auto.components.settings.general.search.41c2f9a025', 'default'),
      translate('auto.components.settings.general.search.95b63edde7', 'claude'),
      translate('auto.components.settings.general.search.aea7d2cccb', 'openclaude'),
      translate('auto.components.settings.general.search.5baf51c4d9', 'open claude'),
      translate('auto.components.settings.general.search.27d9b996ba', 'codex'),
      translate('auto.components.settings.general.search.882c4896fd', 'opencode'),
      translate('auto.components.settings.general.search.9b0bc30160', 'pi'),
      translate('auto.components.settings.general.search.5fdf1dc2d1', 'omp'),
      translate('auto.components.settings.general.search.3c30fe2d51', 'gemini'),
      translate('auto.components.settings.general.search.f472e97440', 'aider'),
      translate('auto.components.settings.general.search.5d9ba08673', 'copilot'),
      translate('auto.components.settings.general.search.c61b14be7c', 'grok')
    ]
  }
])

export const getGeneralSupportSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.general.search.36a72f0d9e', 'Star Orca on GitHub'),
    description: translate(
      'auto.components.settings.general.search.e0b8c8bc25',
      'Support the project with a GitHub star via the gh CLI.'
    ),
    keywords: [
      translate('auto.components.settings.general.search.e4fb4516d0', 'star'),
      translate('auto.components.settings.general.search.06ea5a69a6', 'github'),
      translate('auto.components.settings.general.search.b65665703a', 'support'),
      translate('auto.components.settings.general.search.e6b01c8e30', 'feedback'),
      translate('auto.components.settings.general.search.bdfb6dc21b', 'like')
    ]
  }
])

export const getGeneralPaneSearchEntries = createLocalizedCatalog((): SettingsSearchEntry[] => [
  ...getGeneralWorkspaceSearchEntries(),
  ...getGeneralNetworkSearchEntries(),
  ...getGeneralNavigationSearchEntries(),
  ...getGeneralEditorSearchEntries(),
  ...getGeneralCliSearchEntries(),
  ...getGeneralCacheTimerSearchEntries(),
  ...getGeneralUpdateSearchEntries(),
  ...getGeneralSupportSearchEntries()
])
