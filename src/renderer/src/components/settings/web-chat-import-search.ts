import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getWebChatImportPaneSearchEntries = createLocalizedCatalog(
  (): SettingsSearchEntry[] => [
    {
      title: translate(
        'auto.components.settings.webChatImport.search.title',
        'Web Chat Import Directories'
      ),
      description: translate(
        'auto.components.settings.webChatImport.search.description',
        'Choose the folder each web agent imports conversations from.'
      ),
      keywords: [
        ...translateSearchKeyword(
          'auto.components.settings.webChatImport.search.keywordWebChat',
          'web chat'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.webChatImport.search.keywordImport',
          'import'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.webChatImport.search.keywordChatgpt',
          'ChatGPT',
          { englishOnly: true }
        ),
        ...translateSearchKeyword(
          'auto.components.settings.webChatImport.search.keywordClaudeWeb',
          'Claude.ai',
          { englishOnly: true }
        ),
        ...translateSearchKeyword(
          'auto.components.settings.webChatImport.search.keywordGemini',
          'Gemini',
          { englishOnly: true }
        ),
        ...translateSearchKeyword(
          'auto.components.settings.webChatImport.search.keywordDirectory',
          'directory'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.webChatImport.search.keywordFolder',
          'folder'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.webChatImport.search.keywordAiVault',
          'AI Vault',
          { englishOnly: true }
        )
      ]
    }
  ]
)
