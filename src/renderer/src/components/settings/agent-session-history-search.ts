// Settings-search entries for the Agent Session History pane. Kept in its own
// file to mirror the other per-pane search modules (privacy-search.ts, etc.).

import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getAgentSessionHistoryPaneSearchEntries = createLocalizedCatalog(() => [
  {
    title: translate(
      'auto.components.settings.agentSessionHistory.search.title',
      'Agent Session History'
    ),
    description: translate(
      'auto.components.settings.agentSessionHistory.search.description',
      'Local transcript index that powers full-text search over past agent sessions.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.agentSessionHistory.search.keywordTranscript',
        'transcript'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.agentSessionHistory.search.keywordSearch',
        'search'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.agentSessionHistory.search.keywordIndex',
        'index'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.agentSessionHistory.search.keywordHistory',
        'history'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.agentSessionHistory.search.keywordSessions',
        'sessions'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.agentSessionHistory.search.keywordFullText',
        'full text'
      )
    ]
  },
  {
    title: translate(
      'auto.components.settings.agentSessionHistory.search.enableTitle',
      'Search Inside Conversations'
    ),
    description: translate(
      'auto.components.settings.agentSessionHistory.search.enableDescription',
      'Turn the local transcript index on or off and choose how much history it covers.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.agentSessionHistory.search.keywordEnable',
        'enable'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.agentSessionHistory.search.keywordRetention',
        'retention'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.agentSessionHistory.search.keywordDays',
        'days'
      )
    ]
  },
  {
    title: translate(
      'auto.components.settings.agentSessionHistory.search.clearTitle',
      'Clear Index'
    ),
    description: translate(
      'auto.components.settings.agentSessionHistory.search.clearDescription',
      'Delete the transcript index files and reclaim the disk they use.'
    ),
    keywords: [
      ...translateSearchKeyword(
        'auto.components.settings.agentSessionHistory.search.keywordClear',
        'clear'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.agentSessionHistory.search.keywordDelete',
        'delete'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.agentSessionHistory.search.keywordDisk',
        'disk'
      ),
      ...translateSearchKeyword(
        'auto.components.settings.agentSessionHistory.search.keywordSize',
        'size'
      )
    ]
  }
])
