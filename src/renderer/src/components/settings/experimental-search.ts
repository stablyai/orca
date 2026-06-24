import type { SettingsSearchEntry } from './settings-search'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'
import { translateSearchKeyword } from './settings-search-keywords'
import { getNewWorktreeCardStyleSearchEntry } from './new-worktree-card-style-search-entry'

type KeywordSpec = readonly [key: string, fallback: string]

function entry(
  titleKey: string,
  title: string,
  descriptionKey: string,
  description: string,
  keywords: KeywordSpec[]
): SettingsSearchEntry {
  return {
    title: translate(titleKey, title),
    description: translate(descriptionKey, description),
    keywords: keywords.flatMap(([key, fallback]) => translateSearchKeyword(key, fallback))
  }
}

const experimentalKeyword = [
  'auto.components.settings.experimental.search.0d24759f14',
  'experimental'
] as const

export const getExperimentalPaneSearchEntries = createLocalizedCatalog(
  (): SettingsSearchEntry[] => [
    entry(
      'auto.components.settings.experimental.search.87d99e634b',
      'Pet',
      'auto.components.settings.experimental.search.6b5a56ac35',
      'Floating animated pet in the bottom-right corner.',
      [
        experimentalKeyword,
        ['auto.components.settings.experimental.search.051203d37c', 'pet'],
        ['auto.components.settings.experimental.search.b54cea709b', 'sidekick'],
        ['auto.components.settings.experimental.search.2a33975d72', 'mascot'],
        ['auto.components.settings.experimental.search.9f5609bfb8', 'overlay'],
        ['auto.components.settings.experimental.search.65df471ab2', 'animated'],
        ['auto.components.settings.experimental.search.791fefc0b0', 'corner'],
        ['auto.components.settings.experimental.search.9af7a518db', 'character']
      ]
    ),
    entry(
      'auto.components.settings.experimental.search.ccc5548ac5',
      'Agents View',
      'auto.components.settings.experimental.search.4d63251595',
      'Threaded left-sidebar feed for agent completions and blocking states.',
      [
        experimentalKeyword,
        ['auto.components.settings.experimental.search.fa72e71f05', 'agents'],
        ['auto.components.settings.experimental.search.92a9357d1f', 'agents view'],
        ['auto.components.settings.experimental.search.244a0ecd3d', 'activity'],
        ['auto.components.settings.experimental.search.d01b3882ba', 'notifications'],
        ['auto.components.settings.experimental.search.10b52f79c1', 'worktrees'],
        ['auto.components.settings.experimental.search.ca5d1f3f46', 'timeline'],
        ['auto.components.settings.experimental.search.7b79081695', 'unread'],
        ['auto.components.settings.experimental.search.8facf10138', 'bell'],
        ['auto.components.settings.experimental.search.fe5688b761', 'sidebar']
      ]
    ),
    entry(
      'auto.components.settings.experimental.search.9e4ddf776d',
      'Terminal attention',
      'auto.components.settings.experimental.search.11877246fc',
      'Persistent pane highlight for terminal bell and agent-completion events.',
      [
        experimentalKeyword,
        ['auto.components.settings.experimental.search.9bb3bd5098', 'terminal'],
        ['auto.components.settings.experimental.search.01567f19ca', 'attention'],
        ['auto.components.settings.experimental.search.268e99d957', 'highlight'],
        ['auto.components.settings.experimental.search.edc49480a1', 'pane'],
        ['auto.components.settings.experimental.search.8facf10138', 'bell'],
        ['auto.components.settings.experimental.search.7695fd30e9', 'notification'],
        ['auto.components.settings.experimental.search.5f067ba0f9', 'agent'],
        ['auto.components.settings.experimental.search.f10d307468', 'completion'],
        ['auto.components.settings.experimental.search.7b79081695', 'unread']
      ]
    ),
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
    {
      title: translate(
        'auto.components.settings.experimental.search.78c2a8dc74',
        'Shared paths on worktrees'
      ),
      description: translate(
        'auto.components.settings.experimental.search.603d29ed74',
        'Automatically materialize configured files or folders into newly created worktrees using APFS clone-copy on macOS when possible, otherwise symlinks.'
      ),
      keywords: [
        ...translateSearchKeyword(
          'auto.components.settings.experimental.search.0d24759f14',
          'experimental'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.experimental.search.d23ae13990',
          'worktree'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.experimental.search.10b52f79c1',
          'worktrees'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.experimental.search.c387565812',
          'symlink'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.experimental.search.bff1ff7768',
          'symlinks'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.experimental.search.3028f0bd3a',
          'link'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.experimental.search.f082788cfe',
          'links'
        ),
        ...translateSearchKeyword(
          'auto.components.settings.experimental.search.3021571c30',
          'shared'
        ),
        ...translateSearchKeyword('auto.components.settings.experimental.search.4ad605f222', 'env'),
        ...translateSearchKeyword(
          'auto.components.settings.experimental.search.44c7f209d5',
          'node_modules'
        )
      ]
    },
    entry(
      'auto.components.settings.experimental.search.818dac284f',
      'Multi-window',
      'auto.components.settings.experimental.search.7b91eb5445',
      'Enable File > New Window for multiple monitor workflows. Requires restart.',
      [
        experimentalKeyword,
        ['auto.components.settings.experimental.search.80f98894e2', 'window'],
        ['auto.components.settings.experimental.search.453f52ca4f', 'windows'],
        ['auto.components.settings.experimental.search.0769e2ac8b', 'multi-window'],
        ['auto.components.settings.experimental.search.a546df85b7', 'multiple windows'],
        ['auto.components.settings.experimental.search.065be2a752', 'new window'],
        ['auto.components.settings.experimental.search.f45e79f16d', 'monitor'],
        ['auto.components.settings.experimental.search.d7c9a0880c', 'monitors'],
        ['auto.components.settings.experimental.search.e6798b719e', 'display'],
        ['auto.components.settings.experimental.search.991fc15475', 'displays'],
        ['auto.components.settings.experimental.search.834ea7f3aa', 'restart']
      ]
    )
  ]
)

function findEntry(title: string): SettingsSearchEntry {
  const entry = getExperimentalPaneSearchEntries().find((candidate) => candidate.title === title)
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
    symlinksOnWorktrees: findEntry(
      translate(
        'auto.components.settings.experimental.search.78c2a8dc74',
        'Shared paths on worktrees'
      )
    ),
    multiWindow: findEntry(
      translate('auto.components.settings.experimental.search.818dac284f', 'Multi-window')
    )
  } as const
}
