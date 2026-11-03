import { useId, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { translate as t } from '@/i18n/i18n'

export function SessionLinkDeliveryReview({
  disabled,
  onResolve
}: {
  disabled: boolean
  onResolve: () => void
}): React.JSX.Element {
  const [checked, setChecked] = useState(false)
  const id = useId()
  return (
    <details className="space-y-2 text-xs">
      <summary>{t('components.sessionLink.reviewDelivery', 'Review unconfirmed delivery')}</summary>
      <p className="text-muted-foreground">
        {t(
          'components.sessionLink.reviewDeliveryHelp',
          'This message may already have reached the agent. Check the recipient chat. Marking it reviewed keeps the link paused and allows later messages after you continue; this message will never be resent.'
        )}
      </p>
      <div className="flex items-start gap-2">
        <Checkbox
          id={id}
          disabled={disabled}
          checked={checked}
          onCheckedChange={(value) => setChecked(value === true)}
        />
        <Label htmlFor={id} className="text-xs">
          {t('components.sessionLink.checkedRecipient', 'I checked the recipient chat')}
        </Label>
      </div>
      <Button size="sm" variant="outline" disabled={disabled || !checked} onClick={onResolve}>
        {t('components.sessionLink.resolveDelivery', 'Mark reviewed; do not resend')}
      </Button>
    </details>
  )
}
