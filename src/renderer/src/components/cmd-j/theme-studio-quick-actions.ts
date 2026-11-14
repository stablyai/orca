import { Undo2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { sendThemeStudioUserAction } from '@/app-shell/appearance/theme-studio-bridge'
import { useThemeStudioPreviewStore } from '@/store/appearance/theme-studio-preview-store'
import type { CmdJQuickAction } from './quick-actions'
import type { CmdJQuickActionAvailability } from './quick-action-context'

function availability(): CmdJQuickActionAvailability {
  return useThemeStudioPreviewStore.getState().preview
    ? { available: true }
    : { available: false, reason: 'no-theme-draft' }
}

/** The kill switch for an agent's theme draft, beside the notice's Discard. */
export function getThemeStudioQuickActions(): CmdJQuickAction[] {
  const title = translate(
    'auto.components.cmd.j.quick.actions.discardThemeDraft',
    'Discard Theme Preview'
  )
  return [
    {
      id: 'discard-theme-draft',
      kind: 'action',
      title,
      description: translate(
        'auto.components.cmd.j.quick.actions.discardThemeDraftDescription',
        'Drop the theme an agent is previewing and go back to your own.'
      ),
      icon: Undo2,
      verbKeywords: [
        title,
        translate('auto.components.cmd.j.quick.actions.verbs.discardTheme', 'discard theme'),
        translate('auto.components.cmd.j.quick.actions.verbs.revertTheme', 'revert theme')
      ],
      isAvailable: availability,
      run: async () => {
        if (!availability().available) {
          return { status: 'unavailable', reason: 'no-theme-draft' }
        }
        sendThemeStudioUserAction('discard')
        return { status: 'ok' }
      }
    }
  ]
}
