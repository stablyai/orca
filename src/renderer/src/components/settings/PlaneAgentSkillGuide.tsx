import type { ReactNode } from 'react'
import { Check, Circle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { IntegrationStatusPill } from '@/components/integration-status-pill'
import { translate } from '@/i18n/i18n'

export type PlaneSetupStepStatus = {
  connected: boolean
  connectionChecking: boolean
  skillInstalled: boolean
  skillChecking: boolean
  visibleInTasks: boolean
}

type PlaneAgentSkillGuideProps = {
  status: PlaneSetupStepStatus
  onOpenTaskSources: () => void
  onManagePlaneAccess: () => void
  skillPanel: ReactNode
}

function SetupStatusIcon({
  done,
  checking
}: {
  done: boolean
  checking: boolean
}): React.JSX.Element {
  if (checking) {
    return (
      <span className="flex size-5 items-center justify-center text-muted-foreground">
        <Circle className="size-3.5 animate-pulse motion-reduce:animate-none" />
      </span>
    )
  }
  if (done) {
    return (
      <span className="flex size-5 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
        <Check className="size-3" />
      </span>
    )
  }
  return (
    <span className="flex size-5 items-center justify-center rounded-full border border-border/70 text-muted-foreground">
      <Circle className="size-2.5" />
    </span>
  )
}

export function PlaneAgentSkillGuide({
  status,
  onOpenTaskSources,
  onManagePlaneAccess,
  skillPanel
}: PlaneAgentSkillGuideProps): React.JSX.Element {
  const checking = status.connectionChecking || status.skillChecking
  const completed = [status.connected, status.skillInstalled, status.visibleInTasks].filter(
    Boolean
  ).length
  const total = 3
  const allReady = completed === total && !checking

  return (
    <section className="space-y-3 rounded-xl border border-border/60 bg-card/30 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="space-y-0.5">
          <h3 className="text-sm font-semibold text-foreground">
            {translate(
              'auto.components.settings.PlaneAgentSkillGuide.setupTitle',
              'Setup checklist'
            )}
          </h3>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.PlaneAgentSkillGuide.setupBody',
              'All three are required for the full Tasks + agent loop. First-time path is also under Task Sources.'
            )}
          </p>
        </div>
        <IntegrationStatusPill tone={checking ? 'neutral' : allReady ? 'connected' : 'attention'}>
          {checking
            ? translate('auto.components.settings.PlaneAgentSkillGuide.setupChecking', 'Checking…')
            : allReady
              ? translate('auto.components.settings.PlaneAgentSkillGuide.setupReady', 'All set')
              : translate(
                  'auto.components.settings.PlaneAgentSkillGuide.setupProgress',
                  '{{done}} of {{total}} ready',
                  { done: completed, total }
                )}
        </IntegrationStatusPill>
      </div>

      <div className="divide-y divide-border/50">
        <div className="flex flex-wrap items-start gap-3 py-3">
          <div className="mt-0.5">
            <SetupStatusIcon done={status.connected} checking={status.connectionChecking} />
          </div>
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="text-sm font-medium text-foreground">
              {translate(
                'auto.components.settings.PlaneAgentSkillGuide.setupConnectTitle',
                '1. Connect Plane'
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.PlaneAgentSkillGuide.setupConnectBody',
                'Personal API token so Orca can list issues and open linked workspaces.'
              )}
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant={status.connected ? 'outline' : 'default'}
            className="shrink-0"
            onClick={onManagePlaneAccess}
          >
            {status.connected
              ? translate(
                  'auto.components.settings.PlaneAgentSkillGuide.manageKeys',
                  'Manage access'
                )
              : translate('auto.components.settings.PlaneAgentSkillGuide.addAccess', 'Add access')}
          </Button>
        </div>

        <div className="space-y-3 py-3">
          <div className="flex flex-wrap items-start gap-3">
            <div className="mt-0.5">
              <SetupStatusIcon done={status.skillInstalled} checking={status.skillChecking} />
            </div>
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="text-sm font-medium text-foreground">
                {translate(
                  'auto.components.settings.PlaneAgentSkillGuide.setupSkillTitle',
                  '2. Install the agent skill'
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.PlaneAgentSkillGuide.setupSkillBody',
                  'Gives coding agents /orca-plane for reading, updates, comments, priority, and workflow states.'
                )}
              </p>
            </div>
          </div>
          {skillPanel}
        </div>

        <div className="flex flex-wrap items-start gap-3 py-3">
          <div className="mt-0.5">
            <SetupStatusIcon done={status.visibleInTasks} checking={false} />
          </div>
          <div className="min-w-0 flex-1 space-y-0.5">
            <p className="text-sm font-medium text-foreground">
              {translate(
                'auto.components.settings.PlaneAgentSkillGuide.setupVisibleTitle',
                '3. Show Plane in Tasks'
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.PlaneAgentSkillGuide.setupVisibleBody',
                'Keeps Plane in the Tasks source picker and sidebar shortcuts.'
              )}
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant={status.visibleInTasks ? 'outline' : 'default'}
            className="shrink-0"
            onClick={onOpenTaskSources}
          >
            {translate(
              'auto.components.settings.PlaneAgentSkillGuide.openTaskSources',
              'Task Sources'
            )}
          </Button>
        </div>
      </div>
    </section>
  )
}
