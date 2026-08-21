import type { ReactNode } from 'react'
import { Check, Circle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { IntegrationStatusPill } from '@/components/integration-status-pill'
import { translate } from '@/i18n/i18n'

export type LinearSetupStepStatus = {
  connected: boolean
  connectionChecking: boolean
  skillInstalled: boolean
  skillChecking: boolean
  visibleInTasks: boolean
}

type LinearAgentSkillGuideProps = {
  status: LinearSetupStepStatus
  onOpenTaskSources: () => void
  onManageLinearAccess: () => void
  // Why: skill install/update lives once under step 2 so the page does not
  // repeat an "Agent skill" section after the checklist.
  skillPanel: ReactNode
}

function SetupStatusIcon({
  done,
  checking
}: {
  done: boolean
  checking: boolean
}): React.JSX.Element {
  // Keep a fixed size-5 slot so checking/done/pending never shift the column.
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

// Connect, skill, and Tasks visibility in one checklist — skill UI is inlined.
export function LinearAgentSkillGuide({
  status,
  onOpenTaskSources,
  onManageLinearAccess,
  skillPanel
}: LinearAgentSkillGuideProps): React.JSX.Element {
  // Count durable outcomes even while a recheck runs so the pill does not flash
  // from "All set" down to "2 of 3 ready" during skill/connection scans.
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
              'auto.components.settings.LinearAgentSkillGuide.setupTitle',
              'Setup checklist'
            )}
          </h3>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.LinearAgentSkillGuide.setupBody',
              'All three are required for the full Tasks + agent loop. First-time path is also under Task Sources.'
            )}
          </p>
        </div>
        <IntegrationStatusPill tone={checking ? 'neutral' : allReady ? 'connected' : 'attention'}>
          {checking
            ? translate('auto.components.settings.LinearAgentSkillGuide.setupChecking', 'Checking…')
            : allReady
              ? translate('auto.components.settings.LinearAgentSkillGuide.setupReady', 'All set')
              : translate(
                  'auto.components.settings.LinearAgentSkillGuide.setupProgress',
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
                'auto.components.settings.LinearAgentSkillGuide.setupConnectTitle',
                '1. Connect Linear'
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.LinearAgentSkillGuide.setupConnectBody',
                'Personal API key so Orca can list issues and open linked workspaces.'
              )}
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant={status.connected ? 'outline' : 'default'}
            className="shrink-0"
            onClick={onManageLinearAccess}
          >
            {status.connected
              ? translate(
                  'auto.components.settings.LinearAgentSkillGuide.manageKeys',
                  'Manage keys'
                )
              : translate('auto.components.settings.LinearAgentSkillGuide.addAccess', 'Add access')}
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
                  'auto.components.settings.LinearAgentSkillGuide.setupSkillTitle',
                  '2. Install the agent skill'
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.LinearAgentSkillGuide.setupSkillBody',
                  'Gives coding agents /orca-linear for reading, updates, triage, and attaching pull or merge requests.'
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
                'auto.components.settings.LinearAgentSkillGuide.setupVisibleTitle',
                '3. Show Linear in Tasks'
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.LinearAgentSkillGuide.setupVisibleBody',
                'Keeps Linear in the Tasks source picker and sidebar shortcuts.'
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
              'auto.components.settings.LinearAgentSkillGuide.openTaskSources',
              'Task Sources'
            )}
          </Button>
        </div>
      </div>
    </section>
  )
}
