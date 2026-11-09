import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { TaskSourceStepRow } from './TaskSourceStepRow'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'

type TaskSourceShowInTasksStepProps = {
  index: number
  providerLabel: string
  visible: boolean
  canHide: boolean
  onToggleVisible: () => void
  description?: string
}

export function getShowInTasksLabel(
  visible: boolean,
  canHide: boolean,
  t: Translate = translate
): string {
  if (!visible) {
    return t('auto.components.settings.TaskSourceShowInTasksStep.show', 'Show')
  }
  return canHide
    ? t('auto.components.settings.TaskSourceShowInTasksStep.hide', 'Hide')
    : t('auto.components.settings.TaskSourceShowInTasksStep.shown', 'Shown')
}

export function getShowInTasksLastProviderHint(t: Translate = translate): string {
  return t(
    'auto.components.settings.TaskSourceShowInTasksStep.lastProviderHint',
    'At least one provider must stay visible in Tasks.'
  )
}

export function getShowInTasksActionLabel(
  visible: boolean,
  canHide: boolean,
  providerLabel: string,
  t: Translate = translate
): string {
  if (visible && !canHide) {
    return t(
      'auto.components.settings.TaskSourceShowInTasksStep.lastProviderAction',
      '{{provider}} is shown in Tasks. At least one provider must stay visible.',
      { provider: providerLabel }
    )
  }
  return visible
    ? t(
        'auto.components.settings.TaskSourceShowInTasksStep.hideProviderAction',
        'Hide {{provider}} from Tasks',
        { provider: providerLabel }
      )
    : t(
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
  const t = useTranslate()
  const locked = visible && !canHide

  return (
    <TaskSourceStepRow
      index={index}
      state={visible ? 'done' : 'pending'}
      title={t('auto.components.settings.TaskSourceShowInTasksStep.title', 'Show in Tasks')}
      description={
        description ??
        t(
          'auto.components.settings.TaskSourceShowInTasksStep.description',
          'Include this provider in the Tasks source picker and sidebar shortcuts.'
        )
      }
      action={
        <Button
          type="button"
          size="sm"
          variant={visible ? 'outline' : 'default'}
          // Keep locked providers in tab order so their label/hint can explain why hiding is blocked.
          aria-disabled={locked}
          className={cn(locked && 'cursor-not-allowed opacity-60')}
          aria-label={getShowInTasksActionLabel(visible, canHide, providerLabel, t)}
          onClick={locked ? undefined : onToggleVisible}
        >
          {getShowInTasksLabel(visible, canHide, t)}
        </Button>
      }
    >
      {locked ? (
        <p className="text-[11px] text-muted-foreground">{getShowInTasksLastProviderHint(t)}</p>
      ) : null}
    </TaskSourceStepRow>
  )
}
