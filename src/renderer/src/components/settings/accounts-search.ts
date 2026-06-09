import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getAccountsLocationSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.accounts.search.d09fb5ca92', 'Account Location'),
    description: translate(
      'auto.components.settings.accounts.search.b84a5b0c8a',
      'Choose whether provider accounts are inspected and added on this device or in WSL.'
    ),
    keywords: [
      translate('auto.components.settings.accounts.search.06662af91e', 'account'),
      translate('auto.components.settings.accounts.search.593720c17f', 'location'),
      translate('auto.components.settings.accounts.search.bdbd1e668e', 'windows'),
      translate('auto.components.settings.accounts.search.0b4d948eb5', 'wsl'),
      translate('auto.components.settings.accounts.search.488a7e9206', 'linux'),
      translate('auto.components.settings.accounts.search.9f70aa706c', 'provider'),
      translate('auto.components.settings.accounts.search.e02c136ad0', 'auth')
    ]
  }
])

export const getAccountsClaudeSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.accounts.search.75682e1b62', 'Claude Accounts'),
    description: translate(
      'auto.components.settings.accounts.search.dd75a73991',
      'Optional account switching for Claude while preserving shared chat context.'
    ),
    keywords: [
      translate('auto.components.settings.accounts.search.e14049e1a8', 'claude'),
      translate('auto.components.settings.accounts.search.06662af91e', 'account'),
      translate('auto.components.settings.accounts.search.5b3f18ef4a', 'switch'),
      translate('auto.components.settings.accounts.search.8b06729e0f', 'active'),
      translate('auto.components.settings.accounts.search.86edc96bc9', 'status bar'),
      translate('auto.components.settings.accounts.search.c759741d77', 'quota'),
      translate('auto.components.settings.accounts.search.f2d666a886', 'optional')
    ]
  }
])

export const getAccountsCodexSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate('auto.components.settings.accounts.search.17c5d244eb', 'Codex Accounts'),
    description: translate(
      'auto.components.settings.accounts.search.b40d5b6570',
      'Optional account switching for Codex and live rate limit fetching.'
    ),
    keywords: [
      translate('auto.components.settings.accounts.search.70d1b8def5', 'codex'),
      translate('auto.components.settings.accounts.search.06662af91e', 'account'),
      translate('auto.components.settings.accounts.search.e949b08ffb', 'rate limit'),
      translate('auto.components.settings.accounts.search.86edc96bc9', 'status bar'),
      translate('auto.components.settings.accounts.search.c759741d77', 'quota'),
      translate('auto.components.settings.accounts.search.f2d666a886', 'optional'),
      translate('auto.components.settings.accounts.search.77e32a2ad3', 'reauthenticate'),
      translate('auto.components.settings.accounts.search.02c438bc7b', 'expired'),
      translate('auto.components.settings.accounts.search.042885c07c', 'out of date')
    ]
  },
  {
    title: translate('auto.components.settings.accounts.search.a4bcfd6f86', 'Active Codex Account'),
    description: translate(
      'auto.components.settings.accounts.search.87a4a8584e',
      'Choose which optional saved Codex account powers live quota reads.'
    ),
    keywords: [
      translate('auto.components.settings.accounts.search.70d1b8def5', 'codex'),
      translate('auto.components.settings.accounts.search.06662af91e', 'account'),
      translate('auto.components.settings.accounts.search.5b3f18ef4a', 'switch'),
      translate('auto.components.settings.accounts.search.8b06729e0f', 'active'),
      translate('auto.components.settings.accounts.search.86edc96bc9', 'status bar'),
      translate('auto.components.settings.accounts.search.f2d666a886', 'optional'),
      translate('auto.components.settings.accounts.search.35b461d817', 'sign in')
    ]
  }
])

export const getAccountsGeminiSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate(
      'auto.components.settings.accounts.search.d819755b02',
      'Use Gemini CLI credentials'
    ),
    description: translate(
      'auto.components.settings.accounts.search.bada4a3218',
      'Extracts OAuth credentials from your local Gemini CLI installation to authenticate with Google.'
    ),
    keywords: [
      translate('auto.components.settings.accounts.search.e8e1ff3887', 'gemini'),
      translate('auto.components.settings.accounts.search.8630464352', 'cli'),
      translate('auto.components.settings.accounts.search.933deaf732', 'oauth'),
      translate('auto.components.settings.accounts.search.7118d2f908', 'credentials'),
      translate('auto.components.settings.accounts.search.b7c2cee442', 'experimental'),
      translate('auto.components.settings.accounts.search.e949b08ffb', 'rate limit'),
      translate('auto.components.settings.accounts.search.86edc96bc9', 'status bar')
    ]
  }
])

export const getAccountsOpencodeSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate(
      'auto.components.settings.accounts.search.6ed1401020',
      'OpenCode Go Session Cookie'
    ),
    description: translate(
      'auto.components.settings.accounts.search.d1d2ae383c',
      'Paste your opencode.ai session cookie for rate limit fetching.'
    ),
    keywords: [
      translate('auto.components.settings.accounts.search.8dcbef1856', 'opencode'),
      translate('auto.components.settings.accounts.search.61f7d1fcbe', 'cookie'),
      translate('auto.components.settings.accounts.search.9c4e40cf6b', 'session'),
      translate('auto.components.settings.accounts.search.e949b08ffb', 'rate limit'),
      translate('auto.components.settings.accounts.search.86edc96bc9', 'status bar')
    ]
  },
  {
    title: translate(
      'auto.components.settings.accounts.search.4ee2029e9c',
      'OpenCode Go Workspace ID'
    ),
    description: translate(
      'auto.components.settings.accounts.search.38d22ff8d6',
      'Optional workspace ID override if the automatic lookup fails.'
    ),
    keywords: [
      translate('auto.components.settings.accounts.search.8dcbef1856', 'opencode'),
      translate('auto.components.settings.accounts.search.be8b621bdc', 'workspace'),
      translate('auto.components.settings.accounts.search.421c6be25e', 'id'),
      translate('auto.components.settings.accounts.search.7e67d7d1b6', 'wrk'),
      translate('auto.components.settings.accounts.search.e949b08ffb', 'rate limit'),
      translate('auto.components.settings.accounts.search.86edc96bc9', 'status bar')
    ]
  }
])

export const getAccountsPaneSearchEntries = createLocalizedCatalog((): SettingsSearchEntry[] => [
  ...getAccountsLocationSearchEntries(),
  ...getAccountsClaudeSearchEntries(),
  ...getAccountsCodexSearchEntries(),
  ...getAccountsGeminiSearchEntries(),
  ...getAccountsOpencodeSearchEntries()
])
