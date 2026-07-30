import { useId, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { IntegrationStatusPill } from '@/components/integration-status-pill'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
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

function getSetupStatusLabel(status: TaskProviderSetupStatus): string {
  switch (status) {
    case 'checking':
      return translate(
        'auto.components.settings.TaskSourceProviderCard.statusChecking',
        'Checking…'
      )
    case 'ready':
      return translate('auto.components.settings.TaskSourceProviderCard.statusReady', 'Ready')
    case 'connect-required':
      return translate(
        'auto.components.settings.TaskSourceProviderCard.statusConnectRequired',
        'Connect required'
      )
    case 'skill-required':
      return translate(
        'auto.components.settings.TaskSourceProviderCard.statusSkillRequired',
        'Skill required'
      )
    case 'unavailable':
      return translate(
        'auto.components.settings.TaskSourceProviderCard.statusUnavailable',
        'Status unavailable'
      )
    case 'hidden':
      return translate(
        'auto.components.settings.TaskSourceProviderCard.statusHidden',
        'Hidden from Tasks'
      )
    case 'incomplete':
      return translate(
        'auto.components.settings.TaskSourceProviderCard.statusIncomplete',
        'Needs setup'
      )
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
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [lastDefaultExpanded, setLastDefaultExpanded] = useState(defaultExpanded)
  // Auto-expand only ever opens: collapsing is the user's call, so a readiness
  // change that moves the auto-expand target cannot close a card in use.
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
    <div className="rounded-xl border border-border/60 bg-card/30">
      <div className="flex flex-wrap items-start gap-3 p-3.5">
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
              {getSetupStatusLabel(status)}
            </IntegrationStatusPill>
            {isTaskProviderChecking(readiness) ||
            status === 'ready' ||
            status === 'unavailable' ||
            status === 'hidden' ? null : (
              // Only unfinished providers reach here, so the count is always partial.
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
              // aria-disabled, not disabled: the last visible provider must stay
              // reachable by keyboard so its label can explain why it is locked.
              aria-disabled={visibilityLocked}
              className={cn(visibilityLocked && 'cursor-not-allowed opacity-60')}
              aria-label={getShowInTasksActionLabel(visible, canHide, name)}
              onClick={visibilityLocked ? undefined : onToggleVisible}
            >
              {getShowInTasksLabel(visible, canHide)}
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
                ? translate(
                    'auto.components.settings.TaskSourceProviderCard.collapseSetup',
                    'Collapse {{provider}} setup steps',
                    { provider: name }
                  )
                : translate(
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
        <div id={setupId} className="border-t border-border/50 px-3.5 py-1">
          {children}
        </div>
      ) : null}
    </div>
  )
}
