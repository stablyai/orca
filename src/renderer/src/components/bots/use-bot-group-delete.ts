import { botErrorText } from './bot-presentation'
import { toast } from 'sonner'
import { useTranslate } from '@/i18n/use-translate'
import { useConfirmationDialog } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import { deleteBotGroup } from '@/lib/bot-group-catalog'
import type { BotGroup } from '../../../../shared/bots/bot-group'

/** Confirms, then deletes; true once the group is gone. */
export function useBotGroupDelete(): (group: BotGroup) => Promise<boolean> {
  const t = useTranslate()
  const confirm = useConfirmationDialog()
  return async (group) => {
    const confirmed = await confirm({
      title: t('bots.groups.deleteTitle', 'Delete {{name}}?', { name: group.name }),
      description: t('bots.groups.deleteDescription', 'Its bots are not deleted.'),
      confirmLabel: t('bots.groups.deleteConfirm', 'Delete group'),
      confirmVariant: 'destructive'
    })
    if (!confirmed) {
      return false
    }
    try {
      await deleteBotGroup(group)
      return true
    } catch (error) {
      toast.error(botErrorText(error))
      return false
    }
  }
}
