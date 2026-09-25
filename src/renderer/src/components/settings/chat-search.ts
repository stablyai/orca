import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'
import type { SettingsSearchEntry } from './settings-search'
import { translateSearchKeyword } from './settings-search-keywords'

export type ChatSettingRowId =
  | 'chat-ui'
  | 'chat-default-view'
  | 'chat-resume-on-restart'
  | 'chat-shell-environment'

type ChatSearchEntry = SettingsSearchEntry & { id: ChatSettingRowId }

// Why: these rows configure host-owned structured sessions; a paired web client only writes browser storage.
const HOST_OWNED_ROW_IDS: ReadonlySet<ChatSettingRowId> = new Set([
  'chat-resume-on-restart',
  'chat-shell-environment'
])

const getAllChatPaneSearchEntries = createLocalizedCatalog((): ChatSearchEntry[] => [
  {
    id: 'chat-ui',
    title: translate('auto.components.settings.ChatPane.title', 'Chat UI'),
    description: translate(
      'auto.components.settings.ChatPane.description',
      'Chat view for supported agent sessions.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.chat.search.native', 'native'),
      ...translateSearchKeyword('auto.components.settings.chat.search.chat', 'chat'),
      ...translateSearchKeyword('auto.components.settings.chat.search.claude', 'claude'),
      ...translateSearchKeyword('auto.components.settings.chat.search.codex', 'codex'),
      ...translateSearchKeyword('auto.components.settings.chat.search.openclaude', 'openclaude'),
      ...translateSearchKeyword('auto.components.settings.chat.search.grok', 'grok'),
      ...translateSearchKeyword('auto.components.settings.chat.search.omp', 'omp'),
      ...translateSearchKeyword('auto.components.settings.chat.search.terminal', 'terminal'),
      ...translateSearchKeyword('auto.components.settings.chat.search.agent', 'agent')
    ]
  },
  {
    id: 'chat-default-view',
    title: translate('auto.components.settings.ChatPane.defaultTitle', 'Default view'),
    description: translate(
      'auto.components.settings.ChatPane.defaultCopy',
      'Choose how new supported agent terminal tabs open.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.chat.search.chat', 'chat'),
      ...translateSearchKeyword('auto.components.settings.chat.search.terminal', 'terminal')
    ]
  },
  {
    id: 'chat-resume-on-restart',
    title: translate(
      'auto.components.settings.ChatPane.resumeTitle',
      'Resume working chats automatically after a restart'
    ),
    description: translate(
      'auto.components.settings.ChatPane.resumeCopy',
      'When Orca quits or installs an update, chats that were working are automatically resumed when Orca is reopened.'
    ),
    keywords: translateSearchKeyword('auto.components.settings.chat.search.chat', 'chat')
  },
  {
    id: 'chat-shell-environment',
    title: translate(
      'auto.components.settings.ChatPane.shellEnvTitle',
      'Use your shell environment'
    ),
    description: translate(
      'auto.components.settings.ChatPane.shellEnvCopy',
      'Codex and Claude chats start with every variable your login shell exports, the same as a terminal. Turn off to choose which ones they get.'
    ),
    keywords: translateSearchKeyword('auto.components.settings.chat.search.variables', 'variables')
  }
])

export function getChatPaneSearchEntries({
  includeHostOwnedRows = true
}: { includeHostOwnedRows?: boolean } = {}): ChatSearchEntry[] {
  const entries = getAllChatPaneSearchEntries()
  return includeHostOwnedRows
    ? entries
    : entries.filter((entry) => !HOST_OWNED_ROW_IDS.has(entry.id))
}

export function getChatSearchEntry(id: ChatSettingRowId): ChatSearchEntry {
  const entry = getAllChatPaneSearchEntries().find((candidate) => candidate.id === id)
  if (!entry) {
    throw new Error(`Missing Chat UI search entry: "${id}"`)
  }
  return entry
}
