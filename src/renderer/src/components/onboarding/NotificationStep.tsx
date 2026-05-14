import { cn } from '@/lib/utils'
import { FeatureSetupInlineTerminal } from './FeatureSetupInlineTerminal'
import { FeatureSetupChecklist } from './FeatureSetupChecklist'
import type { OnboardingFeatureSetupSelection } from './onboarding-feature-setup'

// Why: wizard uses positive framing ("notify when focused"); persisted
// setting stays `suppressWhenFocused` and is inverted at the boundary.
export type NotificationDraft = {
  agentTaskComplete: boolean
  terminalBell: boolean
  notifyWhenFocused: boolean
}

type NotificationStepProps = {
  value: NotificationDraft
  onChange: (value: NotificationDraft) => void
  featureSetup: OnboardingFeatureSetupSelection
  onFeatureSetupChange: (value: OnboardingFeatureSetupSelection) => void
  featureSetupCommand: string | null
  featureSetupCommandSelection: OnboardingFeatureSetupSelection | null
}

export function NotificationStep({
  value,
  onChange,
  featureSetup,
  onFeatureSetupChange,
  featureSetupCommand,
  featureSetupCommandSelection
}: NotificationStepProps) {
  const rows: { key: keyof NotificationDraft; title: string; description: string }[] = [
    {
      key: 'agentTaskComplete',
      title: 'Agent task complete',
      description: 'Ping me when an agent finishes its work.'
    },
    {
      key: 'terminalBell',
      title: 'Terminal bell',
      description: 'Play a sound when a terminal rings, usually a question waiting on you.'
    },
    {
      key: 'notifyWhenFocused',
      title: 'Notify even when Orca is focused',
      description: "Show notifications while you're already in the app."
    }
  ]
  return (
    <>
      <div className="overflow-hidden rounded-xl border border-border bg-muted/20">
        {rows.map((row, idx) => (
          <button
            key={row.key}
            type="button"
            role="switch"
            aria-checked={value[row.key]}
            className={cn(
              'flex w-full items-center justify-between gap-6 px-5 py-4 text-left transition-colors hover:bg-muted/50',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
              idx > 0 && 'border-t border-border'
            )}
            onClick={() => onChange({ ...value, [row.key]: !value[row.key] })}
          >
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground">{row.title}</div>
              <div className="mt-0.5 text-[13px] text-muted-foreground">{row.description}</div>
            </div>
            <span
              className={cn(
                'relative h-6 w-11 shrink-0 rounded-full transition-colors',
                value[row.key] ? 'bg-primary' : 'bg-muted-foreground/40'
              )}
            >
              <span
                className={cn(
                  'absolute left-0.5 top-0.5 size-5 rounded-full bg-background shadow-sm transition-transform',
                  value[row.key] && 'translate-x-5'
                )}
              />
            </span>
          </button>
        ))}
      </div>
      <p className="mt-3 text-[13px] text-muted-foreground">
        Configure other agent status personalization, like custom sounds, under{' '}
        <span className="font-medium text-foreground">Settings → Notifications</span>.
      </p>
      <FeatureSetupChecklist value={featureSetup} onChange={onFeatureSetupChange} />
      {featureSetupCommand ? (
        <FeatureSetupInlineTerminal
          command={featureSetupCommand}
          selection={featureSetupCommandSelection ?? featureSetup}
        />
      ) : null}
    </>
  )
}
