// Encryption warning banner and consent checkbox for ConnectionForm.
// Extracted to keep ConnectionForm under the oxlint max-lines limit while
// keeping the security-critical UI in a focused, reviewable module.
import { AlertTriangle } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { translate } from '@/i18n/i18n'

export function EncryptionWarningBanner(): React.JSX.Element {
  return (
    <div className="flex items-start gap-2.5 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-xs text-destructive">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <span>
        {translate(
          'auto.components.database.ConnectionForm.warningBannerBody',
          'The OS has no strong secret store so the password will be saved in a recoverable form on this machine.'
        )}
      </span>
    </div>
  )
}

type ConsentCheckboxProps = {
  checked: boolean
  onCheckedChange: (checked: boolean) => void
}

export function ConsentCheckbox({
  checked,
  onCheckedChange
}: ConsentCheckboxProps): React.JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <Checkbox
        id="conn-consent"
        checked={checked}
        onCheckedChange={(value) => onCheckedChange(value === true)}
      />
      <Label htmlFor="conn-consent" className="cursor-pointer font-normal text-destructive">
        {translate(
          'auto.components.database.ConnectionForm.consentLabel',
          'I understand the password will be stored in a recoverable form'
        )}
      </Label>
    </div>
  )
}
