import { useId } from 'react'
import {
  SESSION_LINK_DEFAULT_TURN_LIMIT,
  type SessionLinkPolicy
} from '../../../../shared/session-link'
import { translate as t } from '@/i18n/i18n'
import { SecuritySurface } from '@/components/ui/security-surface'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'

export function SessionLinkPolicyField({
  value,
  onChange,
  disabled
}: {
  value: SessionLinkPolicy
  onChange: (value: SessionLinkPolicy) => void
  disabled: boolean
}): React.JSX.Element {
  const id = useId()
  return (
    <SecuritySurface>
      <div className="space-y-2">
        <Label htmlFor={id}>
          {t('components.sessionLink.policyLabel', 'Automatic collaboration')}
        </Label>
        <Select
          disabled={disabled}
          value={value.turnLimit === null ? 'continuous' : 'limited'}
          onValueChange={(mode) =>
            onChange({ turnLimit: mode === 'continuous' ? null : SESSION_LINK_DEFAULT_TURN_LIMIT })
          }
        >
          <SelectTrigger id={id} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="continuous">
              {t('components.sessionLink.untilAccepted', 'Until the reviewer accepts the result')}
            </SelectItem>
            <SelectItem value="limited">
              {t('components.sessionLink.customLimit', 'Limit automatic turns')}
            </SelectItem>
          </SelectContent>
        </Select>
        {value.turnLimit !== null ? (
          <div className="space-y-1">
            <Label htmlFor={`${id}-limit`}>
              {t('components.sessionLink.turnLimit', 'Turn limit (1–10,000)')}
            </Label>
            <Input
              id={`${id}-limit`}
              type="number"
              min={1}
              max={10000}
              step={1}
              disabled={disabled}
              value={Number.isFinite(value.turnLimit) ? value.turnLimit : ''}
              aria-invalid={
                !Number.isInteger(value.turnLimit) || value.turnLimit < 1 || value.turnLimit > 10000
              }
              onChange={(e) => onChange({ turnLimit: e.currentTarget.valueAsNumber })}
            />
          </div>
        ) : null}
        <p className="text-xs text-muted-foreground">
          {t(
            'components.sessionLink.policyHelp',
            'One turn is one automatic agent wake-up, including introductions. Repeated messages still pause the link. Spending and other owner decisions require your answer.'
          )}
        </p>
      </div>
    </SecuritySurface>
  )
}
