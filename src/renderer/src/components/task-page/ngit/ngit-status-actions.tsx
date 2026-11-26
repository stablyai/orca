import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useTranslate } from '@/i18n/use-translate'
import type {
  NgitStatusAction,
  NgitWorkItem
} from '../../../../../shared/ngit/ngit-work-item-types'

/** The status changes ngit offers from the item's current state. */
export function ngitStatusActionsFor(
  item: Pick<NgitWorkItem, 'type' | 'state'>
): NgitStatusAction[] {
  if (item.type === 'issue') {
    return item.state === 'open' || item.state === 'draft' ? ['close', 'resolved'] : ['reopen']
  }
  switch (item.state) {
    case 'open':
      return ['close', 'draft', 'applied']
    case 'draft':
      return ['close', 'ready']
    case 'closed':
      return ['reopen']
    case 'merged':
      return []
  }
}

function actionLabel(action: NgitStatusAction, type: NgitWorkItem['type']): string {
  // A bare "Close" would read as closing the panel.
  if (action === 'close') {
    return type === 'issue'
      ? translate('components.taskPage.ngit.actionCloseIssue', 'Close issue')
      : translate('components.taskPage.ngit.actionClosePr', 'Close PR')
  }
  const labels: Record<Exclude<NgitStatusAction, 'close'>, string> = {
    resolved: translate('components.taskPage.ngit.actionResolved', 'Mark resolved'),
    reopen: translate('components.taskPage.ngit.actionReopen', 'Reopen'),
    ready: translate('components.taskPage.ngit.actionReady', 'Ready for review'),
    draft: translate('components.taskPage.ngit.actionDraft', 'Convert to draft'),
    applied: translate('components.taskPage.ngit.actionAppliedElsewhere', 'Mark merged elsewhere')
  }
  return labels[action]
}

export function NgitStatusActions({
  item,
  disabled,
  onAction
}: {
  item: Pick<NgitWorkItem, 'type' | 'state'>
  disabled: boolean
  onAction: (action: NgitStatusAction) => void
}): React.JSX.Element {
  // Subscribes the labels to language changes.
  useTranslate()
  return (
    <>
      {ngitStatusActionsFor(item).map((action) => (
        <Button
          key={action}
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() => onAction(action)}
        >
          {actionLabel(action, item.type)}
        </Button>
      ))}
    </>
  )
}
