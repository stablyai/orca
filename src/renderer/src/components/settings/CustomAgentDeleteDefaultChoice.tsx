import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { SettingsBadge } from './SettingsFormControls'
import type { DeleteDefaultChoice, DeleteDefaultRecommendation } from './custom-agent-delete-plan'

export type CustomAgentDeleteDefaultChoiceProps = {
  baseLabel: string
  value: DeleteDefaultChoice
  recommendation: DeleteDefaultRecommendation
  onChange: (value: DeleteDefaultChoice) => void
}

type ChoiceCopy = { value: DeleteDefaultChoice; label: string; description: string }

// Distinct built-in-global (`base`) vs stock-fallback (`keep`) copy is a Gate G8
// requirement: `base` uses the built-in's own configured launch fields, while
// `keep` runs only the plain stock command.
function choiceCopies(baseLabel: string): ChoiceCopy[] {
  return [
    {
      value: 'base',
      label: translate(
        'auto.components.settings.CustomAgentDeleteDialog.defaultBaseLabel',
        'Set default to {{base}}',
        { base: baseLabel }
      ),
      description: translate(
        'auto.components.settings.CustomAgentDeleteDialog.defaultBaseDescription',
        "Uses {{base}}'s own command, arguments, and environment.",
        { base: baseLabel }
      )
    },
    {
      value: 'auto',
      label: translate(
        'auto.components.settings.CustomAgentDeleteDialog.defaultAutoLabel',
        'Set default to Auto'
      ),
      description: translate(
        'auto.components.settings.CustomAgentDeleteDialog.defaultAutoDescription',
        'Orca picks an installed agent at launch.'
      )
    },
    {
      value: 'keep',
      label: translate(
        'auto.components.settings.CustomAgentDeleteDialog.defaultKeepLabel',
        'Keep a fallback to stock {{base}}',
        { base: baseLabel }
      ),
      description: translate(
        'auto.components.settings.CustomAgentDeleteDialog.defaultKeepDescription',
        'Launches the plain {{base}} command with no custom settings.',
        { base: baseLabel }
      )
    },
    {
      value: 'clear',
      label: translate(
        'auto.components.settings.CustomAgentDeleteDialog.defaultClearLabel',
        'Clear the default'
      ),
      description: translate(
        'auto.components.settings.CustomAgentDeleteDialog.defaultClearDescription',
        'Settings will ask you to choose one.'
      )
    }
  ]
}

export function CustomAgentDeleteDefaultChoice({
  baseLabel,
  value,
  recommendation,
  onChange
}: CustomAgentDeleteDefaultChoiceProps): React.JSX.Element {
  const copies = choiceCopies(baseLabel)
  return (
    <div
      role="radiogroup"
      aria-label={translate(
        'auto.components.settings.CustomAgentDeleteDialog.defaultChoiceLabel',
        'What should the default agent become?'
      )}
      className="space-y-1.5"
    >
      {copies.map((copy) => {
        const active = copy.value === value
        const recommended = copy.value === recommendation.recommended
        return (
          <button
            key={copy.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(copy.value)}
            className={cn(
              'w-full rounded-md border px-3 py-2 text-left outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50',
              active
                ? 'border-primary bg-accent'
                : 'border-border hover:border-border/80 hover:bg-muted/40'
            )}
          >
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">{copy.label}</span>
              {recommended ? (
                <SettingsBadge tone="accent">
                  {translate(
                    'auto.components.settings.CustomAgentDeleteDialog.recommendedBadge',
                    'Recommended'
                  )}
                </SettingsBadge>
              ) : null}
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">{copy.description}</p>
          </button>
        )
      })}
    </div>
  )
}
