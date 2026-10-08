import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'
import type { SettingsSearchEntry } from './settings-search'
import { translateSearchKeyword } from './settings-search-keywords'

const CHAT_SETTING_ROW_IDS = [
  'chat-ui',
  'chat-queue-follow-ups',
  'chat-resume-on-restart',
  'chat-shell-environment'
] as const

export type ChatSettingRowId = (typeof CHAT_SETTING_ROW_IDS)[number]

type ChatSearchEntry = SettingsSearchEntry & { id: ChatSettingRowId }

/** What decides which Chat UI rows exist. The pane renders exactly the rows indexed from it. */
export type ChatUiRowConditions = {
  /** The browser client cannot open chats: its host gives it a terminal, so it gets no rows. */
  isWebClient: boolean
  /** Chat UI is on, or this machine still holds chats: `useLocalStructuredChatsInUse`. */
  structuredChatsInUse: boolean
  /** This machine's runtime holds follow-ups sent mid-turn; without it the switch does nothing. */
  hostQueuesChatMessages: boolean
}

const getAllChatUiSearchEntries = createLocalizedCatalog((): ChatSearchEntry[] => [
  {
    id: 'chat-ui',
    targetSectionId: 'chat-ui',
    title: translate('auto.components.settings.ChatPane.title', 'Chat UI'),
    description: translate(
      'auto.components.settings.ChatPane.description',
      'Open new supported agents in chat.'
    ),
    keywords: [
      ...translateSearchKeyword('auto.components.settings.chat.search.native', 'native'),
      ...translateSearchKeyword('auto.components.settings.chat.search.chat', 'chat'),
      ...translateSearchKeyword('auto.components.settings.chat.search.claude', 'claude'),
      ...translateSearchKeyword('auto.components.settings.chat.search.codex', 'codex'),
      ...translateSearchKeyword('auto.components.settings.chat.search.grok', 'grok'),
      ...translateSearchKeyword('auto.components.settings.chat.search.omp', 'omp'),
      ...translateSearchKeyword('auto.components.settings.chat.search.opencode', 'opencode'),
      ...translateSearchKeyword('auto.components.settings.chat.search.terminal', 'terminal'),
      ...translateSearchKeyword('auto.components.settings.chat.search.agent', 'agent')
    ]
  },
  {
    id: 'chat-queue-follow-ups',
    targetSectionId: 'chat-queue-follow-ups',
    title: translate('components.settings.nativeChat.queueFollowUpsTitle', 'Queue follow-ups'),
    description: translate(
      'components.settings.nativeChat.queueFollowUpsCopy',
      'Messages you send while the agent is working wait as cards you can steer, edit, or delete. Messages with images send right away.'
    ),
    keywords: translateSearchKeyword('auto.components.settings.chat.search.queue', 'queue')
  },
  {
    id: 'chat-resume-on-restart',
    targetSectionId: 'chat-resume-on-restart',
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
    targetSectionId: 'chat-shell-environment',
    title: translate(
      'auto.components.settings.ChatPane.shellEnvTitle',
      'Use your shell environment'
    ),
    description: translate(
      'auto.components.settings.ChatPane.shellEnvCopy',
      'Chats start with every variable your login shell exports, the same as a terminal. Turn off to choose which ones they get.'
    ),
    keywords: translateSearchKeyword('auto.components.settings.chat.search.variables', 'variables')
  }
])

export function getChatUiSearchEntries({
  isWebClient,
  structuredChatsInUse,
  hostQueuesChatMessages
}: ChatUiRowConditions): ChatSearchEntry[] {
  if (isWebClient) {
    return []
  }
  return getAllChatUiSearchEntries().filter(
    (entry) =>
      entry.id === 'chat-ui' ||
      (structuredChatsInUse && (entry.id !== 'chat-queue-follow-ups' || hostQueuesChatMessages))
  )
}

/** The Chat UI rows `entries` index; the pane renders only these, so a row cannot lose its entry. */
export function chatUiRowsIndexedIn(
  entries: readonly SettingsSearchEntry[]
): ReadonlySet<ChatSettingRowId> {
  const indexed = new Set(entries.map((entry) => entry.targetSectionId))
  return new Set(CHAT_SETTING_ROW_IDS.filter((id) => indexed.has(id)))
}

export function getChatSearchEntry(id: ChatSettingRowId): ChatSearchEntry {
  const entry = getAllChatUiSearchEntries().find((candidate) => candidate.id === id)
  if (!entry) {
    throw new Error(`Missing Chat UI search entry: "${id}"`)
  }
  return entry
}
