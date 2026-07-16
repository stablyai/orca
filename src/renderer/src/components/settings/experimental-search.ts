import type { SettingsSearchEntry } from './settings-search'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { getNewWorktreeCardStyleSearchEntry } from './new-worktree-card-style-search-entry'
import { getNativeChatExperimentalSearchEntry } from './native-chat-experimental-search-entry'
import { getEphemeralVmsSearchEntry } from './ephemeral-vms-search'

export const getExperimentalPaneSearchEntries = createLocalizedCatalog(
  (): SettingsSearchEntry[] => [
    {
      title: translate('auto.components.settings.experimental.search.87d99e634b', 'Pet'),
      description: translate(
        'auto.components.settings.experimental.search.6b5a56ac35',
        'Floating animated pet in the bottom-right corner.'
      ),
      keywords: [
        ...translateSearchKeyword(
          'auto.components.settings.experimental.search.0d24759f14',
          'experimental'
        ),
        ...translateSearchKeyword('auto.components.settings.experimental.search.051203d37c', 'pet'),
        ...translateSearchKeyword(
          'auto.components.settings.experimental.search.b54cea709b',
          'sidekick'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.experimental.search.2a33975d72',
          'mascot'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.experimental.search.9f5609bfb8',
          'overlay'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.experimental.search.65df471ab2',
          'animated'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.experimental.search.791fefc0b0',
          'corner'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.experimental.search.9af7a518db',
          'character'
        )
      ]
    },
    {
      title: translate('auto.components.settings.experimental.search.ccc5548ac5', 'Agents View'),
      description: translate(
        'auto.components.settings.experimental.search.4d63251595',
        'Threaded left-sidebar feed for agent completions and blocking states.'
      ),
      keywords: [
        ...translateSearchKeyword(
          'auto.components.settings.experimental.search.0d24759f14',
          'experimental'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.experimental.search.fa72e71f05',
          'agents'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.experimental.search.92a9357d1f',
          'agents view'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.experimental.search.244a0ecd3d',
          'activity'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.experimental.search.d01b3882ba',
          'notifications'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.experimental.search.10b52f79c1',
          'worktrees'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.experimental.search.ca5d1f3f46',
          'timeline'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.experimental.search.7b79081695',
          'unread'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.experimental.search.8facf10138',
          'bell'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.experimental.search.fe5688b761',
          'sidebar'
        )
      ]
    },
    getNativeChatExperimentalSearchEntry(),
    {
      title: translate(
        'auto.components.settings.experimental.search.9e4ddf776d',
        'Terminal attention'
      ),
      description: translate(
        'auto.components.settings.experimental.search.11877246fc',
        'Persistent pane highlight for terminal bell and agent-completion events.'
      ),
      keywords: [
        ...translateSearchKeyword(
          'auto.components.settings.experimental.search.0d24759f14',
          'experimental'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.experimental.search.9bb3bd5098',
          'terminal'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.experimental.search.01567f19ca',
          'attention'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.experimental.search.268e99d957',
          'highlight'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.experimental.search.edc49480a1',
          'pane'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.experimental.search.8facf10138',
          'bell'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.experimental.search.7695fd30e9',
          'notification'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.experimental.search.5f067ba0f9',
          'agent'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.experimental.search.f10d307468',
          'completion'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.experimental.search.7b79081695',
          'unread'
        )
      ]
    },
    {
      title: translate(
        'auto.components.settings.experimental.search.agentHibernation.title',
        'Agent sleep'
      ),
      description: translate(
        'auto.components.settings.experimental.search.agentHibernation.description',
        'Stops idle background agent terminals after the configured idle window and resumes supported sessions when opened again. Agent sleep preserves launch options for agents started by Orca; manually started agents may resume with current Orca defaults.'
      ),
      keywords: [
        ...translateSearchKeyword(
          'auto.components.settings.experimental.search.0d24759f14',
          'experimental'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.experimental.search.agentHibernation.agent',
          'agent'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.experimental.search.agentHibernation.agents',
          'agents'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.experimental.search.agentHibernation.sleep',
          'sleep'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.experimental.search.agentHibernation.minutes',
          'minutes'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.experimental.search.agentHibernation.terminal',
          'terminal'
        )
      ]
    },
    getNewWorktreeCardStyleSearchEntry(),
    getEphemeralVmsSearchEntry()
  ]
)

// Why: title-keyed lookup avoids a fragile numeric-index invariant — the array
// shape can change without breaking consumers, and a typo/rename throws loudly
// instead of silently matching the wrong (or empty) entry.
function findEntry(title: string): SettingsSearchEntry {
  const entry = getExperimentalPaneSearchEntries().find((e) => e.title === title)
  if (!entry) {
    throw new Error(`Missing experimental-pane search entry: "${title}"`)
  }
  return entry
}

export function getExperimentalSearchEntry() {
  return {
    pet: findEntry(translate('auto.components.settings.experimental.search.87d99e634b', 'Pet')),
    agentsView: findEntry(
      translate('auto.components.settings.experimental.search.ccc5548ac5', 'Agents View')
    ),
    nativeChat: findEntry(
      translate('auto.components.settings.experimental.search.nativeChat.title', 'Native chat')
    ),
    terminalAttention: findEntry(
      translate('auto.components.settings.experimental.search.9e4ddf776d', 'Terminal attention')
    ),
    agentHibernation: findEntry(
      translate(
        'auto.components.settings.experimental.search.agentHibernation.title',
        'Agent sleep'
      )
    ),
    newWorktreeCardStyle: findEntry(
      translate(
        'auto.components.settings.experimental.search.newWorktreeCardStyle.title',
        'New card style'
      )
    ),
    ephemeralVms: findEntry(
      translate('auto.components.settings.ephemeralVms.search.title', 'Per-Workspace Environments')
    )
  } as const
}
