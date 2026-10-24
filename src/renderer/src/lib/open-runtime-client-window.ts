import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

/** Asks the desktop for an extra window, optionally opened on one workspace (worktree or folder). */
export async function openRuntimeClientWindowFromRenderer(worktreeId?: string): Promise<void> {
  let opened = false
  try {
    const result = await window.api.ui.openRuntimeClientWindow(
      worktreeId ? { worktreeId } : undefined
    )
    opened = result.ok
    if (!result.ok) {
      console.warn(`[runtime-client-window] Not opened: ${result.reason}`)
    }
  } catch (error) {
    console.warn('[runtime-client-window] Open request failed:', error)
  }
  if (!opened) {
    toast.error(translate('multiWindow.openFailed', 'Could not open a new window'))
  }
}
