import type { SettingsNavTarget } from '@/components/settings/navigation/settings-navigation-types'
import type { CmdJSettingsResult } from '@/components/cmd-j/palette-results'
import { botSettingsTargetFromSectionId } from '@/components/settings/bots/bot-settings-section-ids'

/** The Settings pane (and repo or bot section) a palette settings result opens. */
export function getSettingsTargetFromSectionId(sectionId: string): {
  pane: SettingsNavTarget
  repoId: string | null
  sectionId?: string
} {
  if (sectionId.startsWith('repo-')) {
    return { pane: 'repo', repoId: sectionId.slice('repo-'.length) }
  }
  const pane = sectionId as SettingsNavTarget
  return botSettingsTargetFromSectionId(sectionId) ?? { pane, repoId: null }
}

export function getSettingsTargetFromPaletteResult(result: CmdJSettingsResult) {
  const target = getSettingsTargetFromSectionId(result.sectionId)
  if (result.targetSectionId) {
    target.sectionId = result.targetSectionId
  }
  return target
}
