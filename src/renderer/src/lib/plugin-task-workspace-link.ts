import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { LinkedPluginTask } from '../../../shared/plugins/plugin-task-link'

async function saveCreatedWorkspacePluginTaskLink(
  worktreeId: string,
  link: LinkedPluginTask
): Promise<void> {
  try {
    const result = await useAppStore
      .getState()
      .updateWorktreeMeta(worktreeId, { linkedPluginTask: link })
    if (result.ok) {
      return
    }
    console.error('Failed to save the plugin task link:', result.error)
  } catch (error) {
    console.error('Failed to save the plugin task link:', error)
  }
  toast.error(
    translate(
      'auto.lib.pluginTaskWorkspaceLink.saveFailed',
      'Workspace created, but its link to the plugin task could not be saved.'
    )
  )
}

/** Records which plugin task a just-created workspace came from; a failure is reported, not fatal. */
export function persistCreatedWorkspacePluginTaskLink(
  worktreeId: string,
  link: LinkedPluginTask | undefined
): void {
  if (link) {
    // Why: not awaited, so a slow host never delays opening the workspace or starting its agent.
    void saveCreatedWorkspacePluginTaskLink(worktreeId, link)
  }
}
