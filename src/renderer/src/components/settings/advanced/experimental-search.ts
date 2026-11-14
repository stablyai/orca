import type { SettingsSearchEntry } from '../search/settings-search'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from '../search/settings-search-keywords'
import { getNewWorktreeCardStyleSearchEntry } from './new-worktree-card-style-search-entry'
import { getEphemeralVmsSearchEntry } from '../virtual-machines/recipes/ephemeral-vms-search'
import { getWslHostsExperimentalSearchEntry } from '../wsl/hosts/wsl-hosts-experimental-search'

export const getExperimentalSearchEntry = createLocalizedCatalog(
  () =>
    ({
      pet: {
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
          ...translateSearchKeyword(
            'auto.components.settings.experimental.search.051203d37c',
            'pet'
          ),
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
      agentDashboard: {
        title: translate(
          'auto.components.settings.experimental.search.agentDashboard.eaf17a7214',
          'Agent dashboard'
        ),
        description: translate(
          'auto.components.settings.experimental.search.agentDashboard.description',
          'Kanban board for monitoring agents across worktrees, in-window or as a pop-out.'
        ),
        keywords: [
          ...translateSearchKeyword(
            'auto.components.settings.experimental.search.0d24759f14',
            'experimental'
          ),
          ...translateSearchKeyword(
            'auto.components.settings.experimental.search.agentDashboard.agent',
            'agent'
          ),
          ...translateSearchKeyword(
            'auto.components.settings.experimental.search.agentDashboard.dashboard',
            'dashboard'
          ),
          ...translateSearchKeyword(
            'auto.components.settings.experimental.search.agentDashboard.kanban',
            'kanban'
          ),
          ...translateSearchKeyword(
            'auto.components.settings.experimental.search.agentDashboard.popout',
            'pop-out'
          ),
          ...translateSearchKeyword(
            'auto.components.settings.experimental.search.agentDashboard.board',
            'board'
          ),
          ...translateSearchKeyword(
            'auto.components.settings.experimental.search.agentDashboard.inWindow',
            'in-window'
          ),
          ...translateSearchKeyword(
            'auto.components.settings.experimental.search.agentDashboard.worktrees',
            'worktrees'
          )
        ]
      },
      floatingWorkspacePopout: {
        title: translate(
          'auto.components.settings.experimental.search.floatingWorkspacePopout.title',
          'Floating Workspace pop-out'
        ),
        description: translate(
          'auto.components.settings.experimental.search.floatingWorkspacePopout.description',
          'Open the Floating Workspace terminal in its own window.'
        ),
        keywords: [
          ...translateSearchKeyword(
            'auto.components.settings.experimental.search.0d24759f14',
            'experimental'
          ),
          ...translateSearchKeyword(
            'auto.components.settings.experimental.search.floatingWorkspacePopout.floating',
            'floating'
          ),
          ...translateSearchKeyword(
            'auto.components.settings.experimental.search.agentDashboard.popout',
            'pop-out'
          )
        ]
      },
      terminalAttention: {
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
      agentHibernation: {
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
      newWorktreeCardStyle: getNewWorktreeCardStyleSearchEntry(),
      ephemeralVms: getEphemeralVmsSearchEntry()
    }) satisfies Record<string, SettingsSearchEntry>
)

export const getExperimentalPaneSearchEntries = createLocalizedCatalog(
  (): SettingsSearchEntry[] => [
    ...Object.values(getExperimentalSearchEntry()),
    // Index WSL toggles only on Windows desktops that expose them.
    ...(typeof window !== 'undefined' && window.api?.runtimeEnvironments?.wslHosts
      ? [getWslHostsExperimentalSearchEntry()]
      : [])
  ]
)
