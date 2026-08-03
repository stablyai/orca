import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { TaskSourceStepRow } from './TaskSourceStepRow'
import { translate } from '@/i18n/i18n'

type TaskSourceShowInTasksStepProps = {
  index: number
  providerLabel: string
  visible: boolean
  canHide: boolean
  onToggleVisible: () => void
  description?: string
}

export function getShowInTasksLabel(visible: boolean, canHide: boolean): string {
  if (!visible) {
    return translate('auto.components.settings.TaskSourceShowInTasksStep.show', 'Show')
  }
  return canHide
    ? translate('auto.components.settings.TaskSourceShowInTasksStep.hide', 'Hide')
    : translate('auto.components.settings.TaskSourceShowInTasksStep.shown', 'Shown')
}

export function getShowInTasksLastProviderHint(): string {
  return translate(
    'auto.components.settings.TaskSourceShowInTasksStep.lastProviderHint',
    'At least one provider must stay visible in Tasks.'
  )
}

export function getShowInTasksActionLabel(
  visible: boolean,
  canHide: boolean,
  providerLabel: string
): string {
  if (visible && !canHide) {
    return translate(
      'auto.components.settings.TaskSourceShowInTasksStep.lastProviderAction',
      '{{provider}} is shown in Tasks. At least one provider must stay visible.',
      { provider: providerLabel }
    )
  }
  return visible
    ? translate(
        'auto.components.settings.TaskSourceShowInTasksStep.hideProviderAction',
        'Hide {{provider}} from Tasks',
        { provider: providerLabel }
      )
    : translate(
        'auto.components.settings.TaskSourceShowInTasksStep.showProviderAction',
        'Show {{provider}} in Tasks',
        { provider: providerLabel }
      )
}

export function TaskSourceShowInTasksStep({
  index,
  providerLabel,
  visible,
  canHide,
  onToggleVisible,
  description
}: TaskSourceShowInTasksStepProps): React.JSX.Element {
  const locked = visible && !canHide

  return (
    <TaskSourceStepRow
      index={index}
      state={visible ? 'done' : 'pending'}
      title={translate('auto.components.settings.TaskSourceShowInTasksStep.title', 'Show in Tasks')}
      description={
        description ??
        translate(
          'auto.components.settings.TaskSourceShowInTasksStep.description',
          'Include this provider in the Tasks source picker and sidebar shortcuts.'
        )
      }
      action={
        <Button
          type="button"
          size="sm"
          variant={visible ? 'outline' : 'default'}
          // aria-disabled keeps the locked last provider in the tab order so its
          // label (and the hint below) can explain why it cannot be hidden.
          aria-disabled={locked}
          className={cn(locked && 'cursor-not-allowed opacity-60')}
          aria-label={getShowInTasksActionLabel(visible, canHide, providerLabel)}
          onClick={locked ? undefined : onToggleVisible}
        >
          {getShowInTasksLabel(visible, canHide)}
        </Button>
      }
    >
      {locked ? (
        <p className="text-[11px] text-muted-foreground">{getShowInTasksLastProviderHint()}</p>
      ) : null}
    </TaskSourceStepRow>
  )
}
