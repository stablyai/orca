import { useId } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'

type BrowserProfileUserAgentOptionProps = {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}

export function BrowserProfileUserAgentOption({
  checked,
  onCheckedChange
}: BrowserProfileUserAgentOptionProps): React.JSX.Element {
  const id = useId()
  const descriptionId = `${id}-description`

  return (
    <div className="flex items-start gap-3 rounded-md border border-border/70 p-3">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(nextChecked) => onCheckedChange(nextChecked === true)}
        aria-describedby={descriptionId}
        className="mt-0.5"
      />
      <div className="space-y-1">
        <Label htmlFor={id} className="text-sm">
          {translate(
            'auto.components.browser.profile.user.agent.option.04af3dc12b',
            'Use unmodified user agent'
          )}
        </Label>
        <p id={descriptionId} className="text-xs text-muted-foreground">
          {translate(
            'auto.components.browser.profile.user.agent.option.5bf47a3c91',
            'May improve Google sign-in, but can reduce compatibility with bot-protected sites.'
          )}
        </p>
      </div>
    </div>
  )
}
