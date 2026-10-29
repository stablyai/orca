import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

export function notifyProjectGroupOnOtherHost(): void {
  toast.error(
    translate('auto.store.slices.repos.moveToGroupOtherHost', 'Could not move project to group'),
    {
      description: translate(
        'auto.store.slices.repos.moveToGroupOtherHostDesc',
        'The computer this project runs on does not have this group. A project can only join groups saved on its own computer.'
      )
    }
  )
}
