import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

// Small shared chrome/clipboard helpers for the Gitea work-item sheets
// (GiteaIssueWorkspace / GiteaPullRequestWorkspace).

// On Windows the custom window controls float over the top-right corner, so the
// sheet's header action buttons must clear that strip.
export const isWindows =
  !navigator.userAgent.includes('Mac') && navigator.userAgent.includes('Windows')

export async function copyGiteaText(text: string, label: string): Promise<void> {
  try {
    await window.api.ui.writeClipboardText(text)
    toast.success(
      translate('auto.components.GiteaIssueWorkspace.47b064c003', '{{value0}} copied', {
        value0: label
      })
    )
  } catch {
    toast.error(translate('auto.components.GiteaIssueWorkspace.927222e135', 'Failed to copy.'))
  }
}
