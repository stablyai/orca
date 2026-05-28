import { getDefaultVoiceSettings } from '../../../../shared/constants'
import type { FeatureTip, FeatureTipId } from '../../../../shared/feature-tips'
import type { GlobalSettings } from '../../../../shared/types'

export type FeatureTipPrimaryActionDependencies = {
  closeModal: () => void
  markFeatureTipsSeen: (tipIds: FeatureTipId[]) => void
  openSettingsPage: () => void
  openSettingsTarget: (target: { pane: 'voice'; repoId: null }) => void
  openUrl: (url: string) => void | Promise<void>
  settings: { voice?: GlobalSettings['voice'] } | null | undefined
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}

export function runFeatureTipPrimaryAction(
  tip: FeatureTip,
  deps: FeatureTipPrimaryActionDependencies
): void {
  deps.markFeatureTipsSeen([tip.id])

  switch (tip.action) {
    case 'enable-voice': {
      const voice = deps.settings?.voice ?? getDefaultVoiceSettings()
      void deps.updateSettings({
        voice: {
          ...voice,
          enabled: true
        }
      })
      deps.closeModal()
      deps.openSettingsTarget({ pane: 'voice', repoId: null })
      deps.openSettingsPage()
      break
    }
    case 'open-agent-status-release-notes':
      deps.closeModal()
      void deps.openUrl(tip.releaseNotesUrl)
      break
  }
}
