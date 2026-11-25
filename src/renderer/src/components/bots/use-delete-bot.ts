// Delete bot…, from the sidebar row's menu and from the bot's settings: the same confirm and the same delete.
import { toast } from 'sonner'
import { useConfirmationDialog } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { deleteFolderWorkspaceUnlessUnsaved } from '@/components/sidebar/workspace-actions/deletion/folder-workspace-delete'
import { useTranslate } from '@/i18n/use-translate'
import { deleteBot } from '@/lib/bot-catalog'
import { useAppStore } from '@/store'
import { selectFolderWorkspaceOnHost } from '@/store/folder-workspaces/folder-workspace-record-index'
import type { Bot } from '../../../../shared/bot-types'
import { botErrorMessage, botFolderDisplay } from './bot-presentation'
import { botHomeHostId } from '../../../../shared/bots/bot-home-host'

/** Asks, then deletes; resolves true once the bot is gone. The folder stays on disk. */
export function useDeleteBot(bot: Bot): () => Promise<boolean> {
  const t = useTranslate()
  const confirm = useConfirmationDialog()
  return async () => {
    const home = selectFolderWorkspaceOnHost(
      useAppStore.getState(),
      bot.folderWorkspaceId,
      botHomeHostId(bot)
    )
    const confirmed = await confirm({
      title: t('bots.row.deleteTitle', 'Delete {{name}}?', { name: bot.name }),
      description: t(
        'bots.row.deleteDescription',
        'Its folder stays at {{path}}, with its soul and memory.',
        { path: home?.folderPath ?? botFolderDisplay(bot.folder) }
      ),
      confirmLabel: t('bots.row.deleteConfirm', 'Delete bot'),
      confirmVariant: 'destructive'
    })
    if (!confirmed) {
      return false
    }
    try {
      if (!home) {
        // No home record here (its folder workspace isn't loaded): the bot alone is removed.
        await deleteBot(bot)
        return true
      }
      // The folder-workspace path guards unsaved files and clears the home's tabs; the bot owns the removal.
      // It reports a failed removal only as false, so the host's refusal is kept for the toast.
      let removeError: unknown
      const deleted = await deleteFolderWorkspaceUnlessUnsaved(
        useAppStore.getState,
        home.id,
        bot.hostId,
        {
          remove: () =>
            deleteBot(bot).then(
              () => true,
              (error: unknown) => {
                removeError = error
                throw error
              }
            )
        }
      )
      if (deleted === false) {
        toast.error(botErrorMessage(removeError))
      }
      return deleted === true
    } catch (error) {
      toast.error(botErrorMessage(error))
      return false
    }
  }
}
