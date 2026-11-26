import { useAppStore } from '@/store/index'
import { trackWorktreeCardStyleChanged } from '@/components/sidebar/workspace-card/template/worktree-card-style-telemetry'
import type { GlobalSettings } from '../../../../../../shared/settings/global-settings-types'
import { isProjectTreeOn } from '../../../../../../shared/sidebar-list/project-tree-settings'

/** "Card style" as the user picks it; Tree is the new card style plus the project tree. */
export type CardStyleChoice = 'classic' | 'experimental' | 'tree'

export function isCardStyleChoice(value: string): value is CardStyleChoice {
  return value === 'classic' || value === 'experimental' || value === 'tree'
}

export function readCardStyleChoice(settings: GlobalSettings | null | undefined): CardStyleChoice {
  if (isProjectTreeOn(settings)) {
    return 'tree'
  }
  return settings?.experimentalNewWorktreeCardStyle === true ? 'experimental' : 'classic'
}

export function applyCardStyleChoice(
  choice: CardStyleChoice,
  source: Parameters<typeof trackWorktreeCardStyleChanged>[1]
): void {
  const { settings, updateSettings } = useAppStore.getState()
  const wasExperimental = settings?.experimentalNewWorktreeCardStyle === true
  const experimental = choice !== 'classic'
  void Promise.resolve(
    updateSettings({
      experimentalNewWorktreeCardStyle: experimental,
      experimentalProjectTree: choice === 'tree'
    })
  ).then(() => {
    const state = useAppStore.getState()
    if ((state.settings?.experimentalNewWorktreeCardStyle === true) !== experimental) {
      return
    }
    state.setWorktreeCardsIntroChoice(null)
    if (experimental !== wasExperimental) {
      trackWorktreeCardStyleChanged(experimental, source)
    }
  })
}
