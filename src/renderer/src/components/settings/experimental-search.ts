import type { SettingsSearchEntry } from './settings-search'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'
import { translate } from '@/i18n/i18n'

export const getExperimentalPaneSearchEntries = createLocalizedCatalog(
  (): SettingsSearchEntry[] => [
    {
      title: translate('auto.components.settings.experimental.search.87d99e634b', 'Pet'),
      description: translate(
        'auto.components.settings.experimental.search.6b5a56ac35',
        'Floating animated pet in the bottom-right corner.'
      ),
      keywords: [
        translate('auto.components.settings.experimental.search.0d24759f14', 'experimental'),
        translate('auto.components.settings.experimental.search.051203d37c', 'pet'),
        translate('auto.components.settings.experimental.search.b54cea709b', 'sidekick'),
        translate('auto.components.settings.experimental.search.2a33975d72', 'mascot'),
        translate('auto.components.settings.experimental.search.9f5609bfb8', 'overlay'),
        translate('auto.components.settings.experimental.search.65df471ab2', 'animated'),
        translate('auto.components.settings.experimental.search.791fefc0b0', 'corner'),
        translate('auto.components.settings.experimental.search.9af7a518db', 'character')
      ]
    },
    {
      title: translate('auto.components.settings.experimental.search.ccc5548ac5', 'Agents View'),
      description: translate(
        'auto.components.settings.experimental.search.4d63251595',
        'Threaded left-sidebar feed for agent completions and blocking states.'
      ),
      keywords: [
        translate('auto.components.settings.experimental.search.0d24759f14', 'experimental'),
        translate('auto.components.settings.experimental.search.fa72e71f05', 'agents'),
        translate('auto.components.settings.experimental.search.92a9357d1f', 'agents view'),
        translate('auto.components.settings.experimental.search.244a0ecd3d', 'activity'),
        translate('auto.components.settings.experimental.search.d01b3882ba', 'notifications'),
        translate('auto.components.settings.experimental.search.10b52f79c1', 'worktrees'),
        translate('auto.components.settings.experimental.search.ca5d1f3f46', 'timeline'),
        translate('auto.components.settings.experimental.search.7b79081695', 'unread'),
        translate('auto.components.settings.experimental.search.8facf10138', 'bell'),
        translate('auto.components.settings.experimental.search.fe5688b761', 'sidebar')
      ]
    },
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
        translate('auto.components.settings.experimental.search.0d24759f14', 'experimental'),
        translate('auto.components.settings.experimental.search.9bb3bd5098', 'terminal'),
        translate('auto.components.settings.experimental.search.01567f19ca', 'attention'),
        translate('auto.components.settings.experimental.search.268e99d957', 'highlight'),
        translate('auto.components.settings.experimental.search.edc49480a1', 'pane'),
        translate('auto.components.settings.experimental.search.8facf10138', 'bell'),
        translate('auto.components.settings.experimental.search.7695fd30e9', 'notification'),
        translate('auto.components.settings.experimental.search.5f067ba0f9', 'agent'),
        translate('auto.components.settings.experimental.search.f10d307468', 'completion'),
        translate('auto.components.settings.experimental.search.7b79081695', 'unread')
      ]
    },
    {
      title: translate(
        'auto.components.settings.experimental.search.78c2a8dc74',
        'Symlinks on worktrees'
      ),
      description: translate(
        'auto.components.settings.experimental.search.603d29ed74',
        'Automatically symlink configured files or folders into newly created worktrees so shared state (envs, caches, installs) stays connected.'
      ),
      keywords: [
        translate('auto.components.settings.experimental.search.0d24759f14', 'experimental'),
        translate('auto.components.settings.experimental.search.d23ae13990', 'worktree'),
        translate('auto.components.settings.experimental.search.10b52f79c1', 'worktrees'),
        translate('auto.components.settings.experimental.search.c387565812', 'symlink'),
        translate('auto.components.settings.experimental.search.bff1ff7768', 'symlinks'),
        translate('auto.components.settings.experimental.search.3028f0bd3a', 'link'),
        translate('auto.components.settings.experimental.search.f082788cfe', 'links'),
        translate('auto.components.settings.experimental.search.3021571c30', 'shared'),
        translate('auto.components.settings.experimental.search.4ad605f222', 'env'),
        translate('auto.components.settings.experimental.search.44c7f209d5', 'node_modules')
      ]
    }
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
    terminalAttention: findEntry(
      translate('auto.components.settings.experimental.search.9e4ddf776d', 'Terminal attention')
    ),
    symlinksOnWorktrees: findEntry(
      translate('auto.components.settings.experimental.search.78c2a8dc74', 'Symlinks on worktrees')
    )
  } as const
}
