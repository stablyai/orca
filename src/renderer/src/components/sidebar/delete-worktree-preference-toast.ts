import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { SettingsNavTarget } from '@/lib/settings-navigation-types'
import type { GlobalSettings } from '../../../../shared/types'

export function persistDeleteWorktreeConfirmSkipPreference({
  updateSettings,
  openSettingsPage,
  openSettingsTarget
}: {
  updateSettings: (updates: Partial<GlobalSettings>) => Promise<void>
  openSettingsPage: () => void
  openSettingsTarget: (target: {
    pane: SettingsNavTarget
    repoId: string | null
    sectionId?: string
    intent?: 'add-quick-command'
  }) => void
}): void {
  void updateSettings({ skipDeleteWorktreeConfirm: true })
  // Why: the toast confirms the preference was saved and deep-links to the
  // exact toggle so users can undo a skipped destructive confirmation quickly.
  toast.success(
    translate(
      'auto.components.sidebar.DeleteWorktreeDialog.dd3a45bbbd',
      "We'll skip this confirmation next time."
    ),
    {
      description: translate(
        'auto.components.sidebar.DeleteWorktreeDialog.2b56b35f53',
        'You can change this in Settings.'
      ),
      duration: 8000,
      action: {
        label: translate(
          'auto.components.sidebar.DeleteWorktreeDialog.5cc1a6701c',
          'Open Settings'
        ),
        onClick: () => {
          openSettingsPage()
          openSettingsTarget({
            pane: 'general',
            repoId: null,
            sectionId: 'general-skip-delete-worktree-confirm'
          })
        }
      }
    }
  )
}
