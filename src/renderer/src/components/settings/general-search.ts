import type { SettingsSearchEntry } from './settings-search'
import { getGeneralEditorSearchEntries } from './general-editor-search'
import { translate } from '@/i18n/i18n'
import { searchKeywords, translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { getGeneralProjectRuntimeSearchEntries } from './general-project-runtime-search'
import { getGeneralSupportSearchEntries } from './general-support-search'

export { getGeneralEditorSearchEntries } from './general-editor-search'
export { getGeneralSupportSearchEntries } from './general-support-search'

export const getGeneralWorkspaceSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.general.search.4c95d08fa2', 'Workspace Directory'),
    description: translate(
      'auto.components.settings.general.search.d0bc793689',
      'Root directory where workspace folders are created.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.general.search.7baf524b04', 'workspace'),
      ...translateSearchKeyword('auto.components.settings.general.search.7887a2c262', 'folder'),
      ...translateSearchKeyword('auto.components.settings.general.search.fb4f338a3d', 'path'),
      ...translateSearchKeyword('auto.components.settings.general.search.df10666259', 'worktree')
    ]
  },
  {
    title: translate('auto.components.settings.general.search.141f71c69f', 'Nest Workspaces'),
    description: translate(
      'auto.components.settings.general.search.b9cffd374d',
      'Create workspaces inside a repo-named subfolder.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.general.search.ec5049e510', 'nested'),
      ...translateSearchKeyword('auto.components.settings.general.search.9bde064915', 'subfolder'),
      ...translateSearchKeyword('auto.components.settings.general.search.93f6ec5e70', 'directory')
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
      ...translateSearchKeyword('auto.components.settings.general.search.84c67d0108', 'delete'),
      ...translateSearchKeyword('auto.components.settings.general.search.df10666259', 'worktree'),
      ...translateSearchKeyword('auto.components.settings.general.search.9f8558233a', 'confirm'),
      ...translateSearchKeyword('auto.components.settings.general.search.ca86dd6e27', 'dialog'),
      ...translateSearchKeyword('auto.components.settings.general.search.7e9b556873', 'skip'),
      ...translateSearchKeyword('auto.components.settings.general.search.0efc9d96ad', 'prompt')
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
      ...translateSearchKeyword('auto.components.settings.general.search.84c67d0108', 'delete'),
      ...translateSearchKeyword('auto.components.settings.general.search.7edf4f69e2', 'automation'),
      ...translateSearchKeyword('auto.components.settings.general.search.9f8558233a', 'confirm'),
      ...translateSearchKeyword('auto.components.settings.general.search.ca86dd6e27', 'dialog'),
      ...translateSearchKeyword('auto.components.settings.general.search.7e9b556873', 'skip'),
      ...translateSearchKeyword('auto.components.settings.general.search.0efc9d96ad', 'prompt')
    ]
  },
  {
    title: translate('auto.components.settings.general.search.451d4af994', 'Open In Apps'),
    description: translate(
      'auto.components.settings.general.search.a916662068',
      "Choose apps available from a workspace's Open in menu."
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.general.search.b8093e9a93', 'open in'),
      ...translateSearchKeyword('auto.components.settings.general.search.5a9df5566f', 'open menu'),
      ...translateSearchKeyword('auto.components.settings.general.search.e1ee631696', 'editor'),
      ...translateSearchKeyword('auto.components.settings.general.search.8fb00fcd05', 'launcher'),
      ...translateSearchKeyword('auto.components.settings.general.search.0cb3d94f00', 'cursor'),
      ...translateSearchKeyword('auto.components.settings.general.search.ebf8f056b5', 'zed'),
      ...translateSearchKeyword('auto.components.settings.general.search.dbeb1f348e', 'command'),
      ...translateSearchKeyword('auto.components.settings.general.search.68d03d9980', 'vscode'),
      ...translateSearchKeyword('auto.components.settings.general.search.c9d9636f24', 'finder'),
      ...translateSearchKeyword(
        'auto.components.settings.general.search.6c2ce8457c',
        'file explorer'
      )
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
      ...translateSearchKeyword('auto.components.settings.general.search.20b711ac9e', 'proxy'),
      ...translateSearchKeyword('auto.components.settings.general.search.8f03d44672', 'http_proxy'),
      ...translateSearchKeyword(
        'auto.components.settings.general.search.b9096a44cf',
        'https_proxy'
      ),
      ...translateSearchKeyword('auto.components.settings.general.search.c56cb6f1c2', 'network'),
      ...translateSearchKeyword('auto.components.settings.general.search.9da6c875e5', 'dock'),
      ...translateSearchKeyword('auto.components.settings.general.search.e55d62dfa4', 'launchpad')
    ]
  },
  {
    title: translate('auto.components.settings.general.search.8436ff6f8e', 'Proxy Bypass Rules'),
    description: translate(
      'auto.components.settings.general.search.eb8946b2c9',
      'Hosts that should bypass the configured HTTP proxy.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.general.search.20b711ac9e', 'proxy'),
      ...translateSearchKeyword('auto.components.settings.general.search.3a73054565', 'bypass'),
      ...translateSearchKeyword('auto.components.settings.general.search.91a46caafc', 'no_proxy'),
      ...translateSearchKeyword('auto.components.settings.general.search.3566fce83f', 'localhost'),
      ...translateSearchKeyword('auto.components.settings.general.search.c56cb6f1c2', 'network')
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
      ...translateSearchKeyword(
        'auto.components.settings.general.search.ca812803ea',
        'recent tab order'
      ),
      ...translateSearchKeyword('auto.components.settings.general.search.2a254b725e', 'tab'),
      ...translateSearchKeyword('auto.components.settings.general.search.fe62b3f09f', 'ctrl'),
      ...translateSearchKeyword('auto.components.settings.general.search.750420dd9a', 'control'),
      ...translateSearchKeyword('auto.components.settings.general.search.54ba13831a', 'recent'),
      ...translateSearchKeyword('auto.components.settings.general.search.12ecc640a8', 'mru'),
      ...translateSearchKeyword('auto.components.settings.general.search.f8f0ac213a', 'sequential'),
      ...translateSearchKeyword('auto.components.settings.general.search.fb84767421', 'switch')
    ]
  },
  {
    title: translate(
      'auto.components.settings.general.search.161a86a9da',
      'Confirm before closing pinned tabs'
    ),
    description: translate(
      'auto.components.settings.general.search.8e593f04fc',
      'Show a confirmation dialog before a pinned tab is closed.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.general.search.867dddea41', 'pinned'),
      ...translateSearchKeyword('auto.components.settings.general.search.5250cf0e48', 'pin'),
      ...translateSearchKeyword('auto.components.settings.general.search.2a254b725e', 'tab'),
      ...translateSearchKeyword('auto.components.settings.general.search.9f8558233a', 'confirm'),
      ...translateSearchKeyword('auto.components.settings.general.search.afa37a34e1', 'close')
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
      ...translateSearchKeyword('auto.components.settings.general.search.924a660a78', 'cli'),
      ...translateSearchKeyword('auto.components.settings.general.search.fb4f338a3d', 'path'),
      ...translateSearchKeyword('auto.components.settings.general.search.88d3df9ce9', 'terminal'),
      ...translateSearchKeyword('auto.components.settings.general.search.dbeb1f348e', 'command'),
      ...translateSearchKeyword(
        'auto.components.settings.general.search.0a00691c06',
        'shell command'
      )
    ],
    cmdJKeywords: searchKeywords([
      { key: 'auto.components.settings.general.search.924a660a78', fallback: 'cli' },
      { key: 'auto.components.settings.general.search.fb4f338a3d', fallback: 'path' },
      { key: 'auto.components.settings.general.search.dbeb1f348e', fallback: 'command' },
      { key: 'auto.components.settings.general.search.0a00691c06', fallback: 'shell command' }
    ]),
    targetSectionId: 'cli'
  },
  {
    title: translate('auto.components.settings.general.search.2d9f7b42df', 'Agent skill'),
    description: translate(
      'auto.components.settings.general.search.244e3fb4c8',
      'Install the Orca skill so agents know to use the Orca CLI.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.general.search.bda108e66c', 'skill'),
      ...translateSearchKeyword('auto.components.settings.general.search.baa263d6d8', 'agents'),
      ...translateSearchKeyword('auto.components.settings.general.search.6382fe9724', 'npx')
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
      ...translateSearchKeyword('auto.components.settings.general.search.f89a94773c', 'update'),
      ...translateSearchKeyword('auto.components.settings.general.search.9e86ccd05c', 'version'),
      ...translateSearchKeyword(
        'auto.components.settings.general.search.c9d8c1ce66',
        'release notes'
      ),
      ...translateSearchKeyword('auto.components.settings.general.search.e49e739a59', 'download')
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
      ...translateSearchKeyword('auto.components.settings.general.search.b2601a778c', 'cache'),
      ...translateSearchKeyword('auto.components.settings.general.search.939b80f5fd', 'timer'),
      ...translateSearchKeyword('auto.components.settings.general.search.0efc9d96ad', 'prompt'),
      ...translateSearchKeyword('auto.components.settings.general.search.585beac3f8', 'ttl'),
      ...translateSearchKeyword('auto.components.settings.general.search.95b63edde7', 'claude'),
      ...translateSearchKeyword('auto.components.settings.general.search.660528b048', 'cost'),
      ...translateSearchKeyword('auto.components.settings.general.search.3462308bd3', 'tokens')
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
      ...translateSearchKeyword('auto.components.settings.general.search.8ea37a05bc', 'agent'),
      ...translateSearchKeyword('auto.components.settings.general.search.41c2f9a025', 'default'),
      ...translateSearchKeyword('auto.components.settings.general.search.95b63edde7', 'claude'),
      ...translateSearchKeyword('auto.components.settings.general.search.aea7d2cccb', 'openclaude'),
      ...translateSearchKeyword(
        'auto.components.settings.general.search.5baf51c4d9',
        'open claude'
      ),
      ...translateSearchKeyword('auto.components.settings.general.search.27d9b996ba', 'codex'),
      ...translateSearchKeyword('auto.components.settings.general.search.882c4896fd', 'opencode'),
      ...translateSearchKeyword('auto.components.settings.general.search.9b0bc30160', 'pi'),
      ...translateSearchKeyword('auto.components.settings.general.search.5fdf1dc2d1', 'omp'),
      ...translateSearchKeyword('auto.components.settings.general.search.3c30fe2d51', 'gemini'),
      ...translateSearchKeyword('auto.components.settings.general.search.f472e97440', 'aider'),
      ...translateSearchKeyword('auto.components.settings.general.search.5d9ba08673', 'copilot'),
      ...translateSearchKeyword('auto.components.settings.general.search.c61b14be7c', 'grok'),
      ...translateSearchKeyword('auto.lib.agent.catalog.fc80296033', 'devin')
    ]
  }
])

type GeneralPaneSearchOptions = {
  includeProjectRuntime?: boolean
}

export function getGeneralPaneSearchEntries(
  options: GeneralPaneSearchOptions = {}
): SettingsSearchEntry[] {
  return [
    ...getGeneralWorkspaceSearchEntries(),
    ...getGeneralNetworkSearchEntries(),
    ...getGeneralNavigationSearchEntries(),
    ...(options.includeProjectRuntime === false ? [] : getGeneralProjectRuntimeSearchEntries()),
    ...getGeneralEditorSearchEntries(),
    ...getGeneralCliSearchEntries(),
    ...getGeneralCacheTimerSearchEntries(),
    ...getGeneralUpdateSearchEntries(),
    ...getGeneralSupportSearchEntries()
  ]
}
