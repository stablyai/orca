import {
  getGeneralConfirmationSearchEntries,
  getGeneralMacConfirmationSearchEntries,
  showsMacDesktopConfirmations
} from './general-confirmations-search'
import { getGeneralSubPageTitle } from './general-sub-pages'
import { GENERAL_SETTING_ANCHORS, generalSetting } from './general-setting-anchors'
import type { SettingsSearchEntry } from '../search/settings-search'
import { getGeneralEditorSearchEntries } from '../editor/general-editor-search'
import { translate } from '@/i18n/i18n'
import { searchKeywords, translateSearchKeyword } from '../search/settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { getGeneralProjectRuntimeSearchEntries } from './project-runtime/general-project-runtime-search'
import { getGeneralSupportSearchEntries } from './general-support-search'
import { getUpdateDelayDescription, getUpdateDelayTitle } from '../updates/update-delay-copy'

export const getGeneralWorkspaceSearchDescriptors = createLocalizedCatalog(() => [
  generalSetting(GENERAL_SETTING_ANCHORS.folder, {
    title: translate('auto.components.settings.general.search.0e030ce4e3', 'Workspace directory'),
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
  }),
  generalSetting(GENERAL_SETTING_ANCHORS.worktrees, {
    title: translate(
      'auto.components.settings.general.search.externalWorktrees',
      'External worktrees'
    ),
    description: translate(
      'auto.components.settings.general.search.externalWorktreesDescription',
      'Choose whether worktrees created outside Orca appear by default.'
    ),
    keywords: [
      ...translateSearchKeyword('settings.general.search.keywords.source', 'source'),
      ...translateSearchKeyword('settings.general.search.keywords.root', 'root'),
      ...translateSearchKeyword('settings.general.search.keywords.custom', 'custom'),
      ...translateSearchKeyword('settings.general.search.keywords.location', 'location'),
      ...translateSearchKeyword('settings.general.search.keywords.claude', 'Claude'),
      ...translateSearchKeyword('settings.general.search.keywords.gsd', 'GSD'),
      ...translateSearchKeyword(
        'auto.components.settings.general.search.externalKeyword',
        'external'
      ),
      ...translateSearchKeyword('auto.components.settings.general.search.visibility', 'visibility'),
      ...translateSearchKeyword('auto.components.settings.general.search.sidebar', 'sidebar'),
      ...translateSearchKeyword('auto.components.settings.general.search.df10666259', 'worktree')
    ]
  }),
  generalSetting(GENERAL_SETTING_ANCHORS.nesting, {
    title: translate('settings.general.folder.perProject', 'Folder per project'),
    description: translate(
      'auto.components.settings.general.search.b9cffd374d',
      'Create workspaces inside a repo-named subfolder.'
    ),
    keywords: [
      translate('auto.components.settings.general.search.11003cbcbd', 'Nest workspaces'),
      ...translateSearchKeyword('auto.components.settings.general.search.ec5049e510', 'nested'),
      ...translateSearchKeyword('auto.components.settings.general.search.9bde064915', 'subfolder'),
      ...translateSearchKeyword('auto.components.settings.general.search.93f6ec5e70', 'directory')
    ]
  }),
  generalSetting(GENERAL_SETTING_ANCHORS.openIn, {
    title: translate('auto.components.settings.general.search.da5c42780e', 'Open in apps'),
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
      ...translateSearchKeyword('settings.general.openInMenu.keyword.windsurf', 'windsurf'),
      ...translateSearchKeyword('settings.general.openInMenu.keyword.devin', 'devin'),
      ...translateSearchKeyword(
        'settings.general.openInMenu.keyword.devinDesktop',
        'devin desktop'
      ),
      ...translateSearchKeyword('settings.general.openInMenu.keyword.antigravity', 'antigravity'),
      ...translateSearchKeyword('auto.components.settings.general.search.dbeb1f348e', 'command'),
      ...translateSearchKeyword('auto.components.settings.general.search.68d03d9980', 'vscode'),
      ...translateSearchKeyword('auto.components.settings.general.search.c9d9636f24', 'finder'),
      ...translateSearchKeyword(
        'auto.components.settings.general.search.6c2ce8457c',
        'file explorer'
      )
    ]
  })
])

export const getGeneralNavigationSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.general.search.b180c1041b', 'Tab order'),
    description: translate(
      'auto.components.settings.general.search.e53d585ed6',
      'Recent or tab strip.'
    ),
    keywords: [
      ...translateSearchKeyword('settings.general.search.keywords.tabs', 'tabs'),
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
    title: translate('settings.general.previewTabs.title', 'Preview tabs'),
    description: translate(
      'settings.general.previewTabs.description',
      'Single-clicking a file reuses one preview tab until you edit or pin it.'
    ),
    keywords: [
      translate(
        'auto.components.settings.GeneralPane.editor_preview_tabs',
        'Reuse a preview tab when browsing files'
      ),
      ...translateSearchKeyword('auto.components.settings.general.search.preview', 'preview'),
      ...translateSearchKeyword('auto.components.settings.general.search.2a254b725e', 'tab'),
      ...translateSearchKeyword('auto.components.settings.general.search.reuse', 'reuse'),
      ...translateSearchKeyword('auto.components.settings.general.search.replace', 'replace'),
      ...translateSearchKeyword('auto.components.settings.general.search.explorer', 'explorer'),
      ...translateSearchKeyword('auto.components.settings.general.search.italic', 'italic'),
      ...translateSearchKeyword('auto.components.settings.general.search.browsing', 'browsing')
    ]
  }
])

export const getGeneralCliSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('settings.general.cli.otherTerminals', '{{command}} in other terminals', {
      command: 'orca'
    }),
    description: translate(
      'auto.components.settings.general.search.ca529079bf',
      'Register or remove the Orca CLI command.'
    ),
    keywords: [
      translate('auto.components.settings.general.search.327e3fa70d', 'Orca CLI'),
      ...translateSearchKeyword('settings.general.search.keywords.command_line', 'command line'),
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
    title: translate('settings.general.cli.skillTitle', 'Orca skill for agents'),
    description: translate(
      'auto.components.settings.general.search.244e3fb4c8',
      'Install the Orca skill so agents know to use the Orca CLI.'
    ),
    keywords: [
      translate('auto.components.settings.general.search.2d9f7b42df', 'Agent skill'),
      ...translateSearchKeyword('auto.components.settings.general.search.bda108e66c', 'skill'),
      ...translateSearchKeyword('auto.components.settings.general.search.baa263d6d8', 'agents')
    ]
  }
])

export const getGeneralUpdateSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.general.search.0504f69ba0', 'Check for updates'),
    description: translate(
      'auto.components.settings.general.search.79ff46776e',
      'Check for app updates and install a newer Orca version.'
    ),
    keywords: [
      ...translateSearchKeyword('settings.general.search.keywords.about', 'about'),
      ...translateSearchKeyword('auto.components.settings.general.search.f89a94773c', 'update'),
      ...translateSearchKeyword('auto.components.settings.general.search.9e86ccd05c', 'version'),
      ...translateSearchKeyword(
        'auto.components.settings.general.search.c9d8c1ce66',
        'release notes'
      ),
      ...translateSearchKeyword('auto.components.settings.general.search.e49e739a59', 'download')
    ]
  },
  {
    title: getUpdateDelayTitle(),
    description: getUpdateDelayDescription(),
    keywords: [
      ...translateSearchKeyword('settings.updateDelay.keywordDelay', 'delay'),
      ...translateSearchKeyword('settings.updateDelay.keywordCooldown', 'cooldown'),
      ...translateSearchKeyword('settings.updateDelay.keywordSecurity', 'security')
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
    ...getGeneralNavigationSearchEntries(),
    ...Object.values(getGeneralConfirmationSearchEntries()),
    ...(showsMacDesktopConfirmations()
      ? Object.values(getGeneralMacConfirmationSearchEntries())
      : []),
    ...getGeneralDestinationSearchEntries(),
    ...(options.includeProjectRuntime === false ? [] : getGeneralProjectRuntimeSearchEntries()),
    ...getGeneralEditorSearchEntries(),
    ...getGeneralCliSearchEntries(),
    ...getGeneralUpdateSearchEntries(),
    ...getGeneralSupportSearchEntries()
  ]
}

export const getGeneralWorkspaceSearchEntries = createLocalizedCatalog(() =>
  getGeneralWorkspaceSearchDescriptors().map(({ entry }) => entry)
)

export const getGeneralDestinationSearchEntries = createLocalizedCatalog(() => [
  ...(['folder', 'worktrees', 'open-in', 'editor'] as const).map((page) => ({
    title: getGeneralSubPageTitle(page, translate)
  })),
  {
    title: translate('settings.general.about.title', 'About'),
    keywords: [
      ...translateSearchKeyword('settings.general.search.keywords.update', 'update'),
      ...translateSearchKeyword('settings.general.search.keywords.version', 'version'),
      ...translateSearchKeyword('settings.general.search.keywords.star', 'star')
    ]
  }
])
