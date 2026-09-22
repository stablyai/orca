import { ArrowRight, CalendarClock } from 'lucide-react'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { Button } from '@/components/ui/button'
import { SettingsSwitchRow } from './SettingsFormControls'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'

export function AutomationsSettingsPane({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => Promise<void>
}): React.JSX.Element {
  const openAutomationsPage = useAppStore((state) => state.openAutomationsPage)

  return (
    <div className="divide-y divide-border">
      <SettingsSwitchRow
        label={translate(
          'auto.components.settings.automations.showButton',
          'Show Automations Button'
        )}
        description={translate(
          'auto.components.settings.automations.showButtonDescription',
          'Show the Automations shortcut in the sidebar.'
        )}
        checked={settings.showAutomationsButton !== false}
        onChange={() =>
          void updateSettings({
            showAutomationsButton: settings.showAutomationsButton === false
          })
        }
      />
      <section className="space-y-4 py-5">
        <div className="space-y-1">
          <h3 className="text-sm font-medium">
            {translate(
              'auto.components.settings.automations.howItWorksTitle',
              'How Automations work'
            )}
          </h3>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {translate(
              'auto.components.settings.automations.howItWorksDescription',
              'Schedule agent work once, then let Orca create each run and keep its results together.'
            )}
          </p>
        </div>

        <ol className="space-y-3">
          <li className="flex items-start gap-3">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border/60 bg-muted/30 text-[11px] font-semibold text-muted-foreground">
              1
            </span>
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="text-sm font-medium">
                {translate(
                  'auto.components.settings.automations.defineStepTitle',
                  'Describe the work'
                )}
              </p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {translate(
                  'auto.components.settings.automations.defineStepDescription',
                  'Choose a project, agent, prompt, and schedule.'
                )}
              </p>
            </div>
          </li>
          <li className="flex items-start gap-3">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border/60 bg-muted/30 text-[11px] font-semibold text-muted-foreground">
              2
            </span>
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="text-sm font-medium">
                {translate(
                  'auto.components.settings.automations.runStepTitle',
                  'Orca starts each run'
                )}
              </p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {translate(
                  'auto.components.settings.automations.runStepDescription',
                  'The selected agent gets a fresh workspace when the schedule is due.'
                )}
              </p>
            </div>
          </li>
          <li className="flex items-start gap-3">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full border border-border/60 bg-muted/30 text-[11px] font-semibold text-muted-foreground">
              3
            </span>
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="text-sm font-medium">
                {translate(
                  'auto.components.settings.automations.reviewStepTitle',
                  'Review the results'
                )}
              </p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                {translate(
                  'auto.components.settings.automations.reviewStepDescription',
                  'Inspect recent runs and continue the work whenever you need to.'
                )}
              </p>
            </div>
          </li>
        </ol>

        <Button
          type="button"
          variant="ghost"
          className="h-auto w-full justify-start whitespace-normal rounded-md border border-border/60 bg-muted/20 px-4 py-3 text-left hover:bg-muted/35 hover:text-foreground"
          onClick={openAutomationsPage}
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground">
            <CalendarClock className="size-4" />
          </span>
          <span className="min-w-0 flex-1 space-y-0.5">
            <span className="block text-sm font-medium text-foreground">
              {translate(
                'auto.components.settings.automations.openAutomations',
                'Open Automations'
              )}
            </span>
            <span className="block text-xs font-normal text-muted-foreground">
              {translate(
                'auto.components.settings.automations.openAutomationsDescription',
                'Create schedules and inspect recent runs.'
              )}
            </span>
          </span>
          <ArrowRight className="ml-auto size-4 shrink-0 text-muted-foreground" />
        </Button>
      </section>
    </div>
  )
}
