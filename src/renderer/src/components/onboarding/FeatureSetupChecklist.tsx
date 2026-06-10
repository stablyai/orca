import type { ReactNode } from 'react'
import { Check, Globe2, MonitorCog, Workflow } from 'lucide-react'
import { cn } from '@/lib/utils'
import type {
  OnboardingFeatureSetupId,
  OnboardingFeatureSetupSelection
} from './onboarding-feature-setup'
import { translate } from '@/i18n/i18n'

type FeatureSetupChecklistProps = {
  value: OnboardingFeatureSetupSelection
  onChange: (value: OnboardingFeatureSetupSelection) => void
}

type FeatureSetupRow = {
  id: OnboardingFeatureSetupId
  title: string
  description: string
  setupSummary: string
  icon: ReactNode
}

const FEATURE_SETUP_ROWS: readonly FeatureSetupRow[] = [
  {
    id: 'browserUse',
    title: translate(
      'auto.components.onboarding.FeatureSetupChecklist.ea85d9e628',
      'Agent Browser Use'
    ),
    description: translate(
      'auto.components.onboarding.FeatureSetupChecklist.01426f3a23',
      'Agents can navigate sites, inspect pages, and work through browser tasks.'
    ),
    setupSummary: 'Enables browser use, prepares orca-cli, and leaves cookies for Settings.',
    icon: <Globe2 className="size-4" />
  },
  {
    id: 'computerUse',
    title: translate('auto.components.onboarding.FeatureSetupChecklist.1ecfb490ac', 'Computer Use'),
    description: translate(
      'auto.components.onboarding.FeatureSetupChecklist.c5292c409d',
      'Agents can inspect app windows and operate local apps when you ask.'
    ),
    setupSummary: 'Registers the Orca CLI, opens permissions, and prepares the skill.',
    icon: <MonitorCog className="size-4" />
  },
  {
    id: 'orchestration',
    title: translate(
      'auto.components.onboarding.FeatureSetupChecklist.399cf885c0',
      'Agent Orchestration'
    ),
    description: translate(
      'auto.components.onboarding.FeatureSetupChecklist.77f74946f5',
      'Agents can message each other, take tasks, and coordinate handoffs.'
    ),
    setupSummary: 'Registers the Orca CLI, enables orchestration, and prepares the skill.',
    icon: <Workflow className="size-4" />
  }
]

export function FeatureSetupChecklist({
  value,
  onChange
}: FeatureSetupChecklistProps): React.JSX.Element {
  return (
    <section className="mt-6">
      <div className="grid gap-3 md:grid-cols-3">
        {FEATURE_SETUP_ROWS.map((row) => {
          const selected = value[row.id]
          return (
            <button
              key={row.id}
              type="button"
              role="checkbox"
              aria-checked={selected}
              className={cn(
                'flex min-h-40 flex-col rounded-lg border px-4 py-3 text-left transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
                selected
                  ? 'border-violet-500/60 bg-violet-500/10 text-foreground ring-2 ring-violet-500/30'
                  : 'border-border bg-muted/20 text-muted-foreground hover:bg-muted/40'
              )}
              onClick={() => onChange({ ...value, [row.id]: !selected })}
            >
              <span className="flex items-start justify-between gap-3">
                <span
                  className={cn(
                    'flex size-8 items-center justify-center rounded-lg border',
                    selected
                      ? 'border-border bg-muted text-foreground'
                      : 'border-border bg-muted/40'
                  )}
                >
                  {row.icon}
                </span>
                <span
                  aria-hidden
                  className={cn(
                    'flex size-5 items-center justify-center rounded-full border transition-colors',
                    selected
                      ? 'border-violet-500 bg-violet-500 text-white'
                      : 'border-border bg-background'
                  )}
                >
                  {selected ? <Check className="size-3" strokeWidth={3} /> : null}
                </span>
              </span>
              <span className="mt-3 text-sm font-medium text-foreground">{row.title}</span>
              <span className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {row.description}
              </span>
              <span className="mt-auto pt-3 text-[11px] leading-relaxed text-muted-foreground">
                {row.setupSummary}
              </span>
            </button>
          )
        })}
      </div>
    </section>
  )
}
