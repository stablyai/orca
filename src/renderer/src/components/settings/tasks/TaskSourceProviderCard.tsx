import { useId, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { IntegrationStatusPill } from '@/components/integration-status-pill'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/class-names'
import { getShowInTasksActionLabel, getShowInTasksLabel } from './TaskSourceShowInTasksStep'
import {
  TASK_PROVIDER_SETUP_STATUS_TONE,
  getTaskProviderCompletedSteps,
  getTaskProviderSetupStatus,
  isTaskProviderChecking,
  type TaskProviderReadiness,
  type TaskProviderSetupStatus
} from './task-source-setup-state'
import { translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'

type TaskSourceProviderCardProps = {
  icon: ReactNode
  name: string
  description: string
  readiness: TaskProviderReadiness
  visible: boolean
  canHide: boolean
  defaultExpanded: boolean
  onToggleVisible: () => void
  children?: ReactNode
}

function getSetupStatusLabel(status: TaskProviderSetupStatus, t: Translate = translate): string {
  switch (status) {
    case 'checking':
      return t('auto.components.settings.TaskSourceProviderCard.statusChecking', 'Checking…')
    case 'ready':
      return t('auto.components.settings.TaskSourceProviderCard.statusReady', 'Ready')
    case 'connect-required':
      return t(
        'auto.components.settings.TaskSourceProviderCard.statusConnectRequired',
        'Connect required'
      )
    case 'skill-required':
      return t(
        'auto.components.settings.TaskSourceProviderCard.statusSkillRequired',
        'Skill required'
      )
    case 'skill-unverified':
      return t('auto.components.settings.TaskSourceProviderCard.statusUnverified', 'Cannot verify')
    case 'unavailable':
      return t(
        'auto.components.settings.TaskSourceProviderCard.statusUnavailable',
        'Status unavailable'
      )
    case 'hidden':
      return t('auto.components.settings.TaskSourceProviderCard.d2d9e9707b', 'Hidden from tasks')
    case 'incomplete':
      return t('auto.components.settings.TaskSourceProviderCard.statusIncomplete', 'Needs setup')
  }
}

export function TaskSourceProviderCard({
  icon,
  name,
  description,
  readiness,
  visible,
  canHide,
  defaultExpanded,
  onToggleVisible,
  children
}: TaskSourceProviderCardProps): React.JSX.Element {
  const t = useTranslate()
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [lastDefaultExpanded, setLastDefaultExpanded] = useState(defaultExpanded)
  // Automatic readiness updates may open cards but cannot close a card the user is using.
  if (lastDefaultExpanded !== defaultExpanded) {
    setLastDefaultExpanded(defaultExpanded)
    if (defaultExpanded) {
      setExpanded(true)
    }
  }
  const status = getTaskProviderSetupStatus(readiness)
  const progress = getTaskProviderCompletedSteps(readiness)
  const visibilityLocked = visible && !canHide
  const setupId = useId()

  return (
    <div>
      <div className="flex flex-wrap items-start gap-3 py-3.5">
        <span
          className={cn(
            'flex size-9 shrink-0 items-center justify-center rounded-md border',
            readiness.connected
              ? 'border-foreground/15 bg-background/80'
              : 'border-border/60 bg-muted/40 text-muted-foreground'
          )}
        >
          {icon}
        </span>

        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold text-foreground">{name}</p>
            <IntegrationStatusPill tone={TASK_PROVIDER_SETUP_STATUS_TONE[status]}>
              {getSetupStatusLabel(status, t)}
            </IntegrationStatusPill>
            {isTaskProviderChecking(readiness) ||
            status === 'ready' ||
            status === 'unavailable' ||
            status === 'hidden' ? null : (
              <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                {`${progress.completed}/${progress.total}`}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{description}</p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {!expanded ? (
            <Button
              type="button"
              size="sm"
              variant={visible ? 'outline' : 'secondary'}
              // Keep the last visible provider keyboard-focusable so its lock reason remains discoverable.
              aria-disabled={visibilityLocked}
              className={cn(visibilityLocked && 'cursor-not-allowed opacity-60')}
              aria-label={getShowInTasksActionLabel(visible, canHide, name, t)}
              onClick={visibilityLocked ? undefined : onToggleVisible}
            >
              {getShowInTasksLabel(visible, canHide, t)}
            </Button>
          ) : null}
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            aria-expanded={expanded}
            aria-controls={setupId}
            aria-label={
              expanded
                ? t(
                    'auto.components.settings.TaskSourceProviderCard.collapseSetup',
                    'Collapse {{provider}} setup steps',
                    { provider: name }
                  )
                : t(
                    'auto.components.settings.TaskSourceProviderCard.expandSetup',
                    'Show {{provider}} setup steps',
                    { provider: name }
                  )
            }
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
          </Button>
        </div>
      </div>

      {expanded ? (
        <div id={setupId} className="border-t border-border/50 py-1 pl-12">
          {children}
        </div>
      ) : null}
    </div>
  )
}
