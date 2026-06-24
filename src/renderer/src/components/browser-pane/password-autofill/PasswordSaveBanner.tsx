import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { hostnameFromOrigin } from '../../../../../shared/browser-credential-hostname'
import type { PendingPasswordCapture } from './use-password-autofill'

type PasswordSaveBannerProps = {
  pending: PendingPasswordCapture | null
  onSave: () => void
  onDismiss: () => void
}

// Why: non-modal bar; renders nothing when pending is null so the caller can
// always mount this without a visibility gate.
export function PasswordSaveBanner({
  pending,
  onSave,
  onDismiss
}: PasswordSaveBannerProps): React.JSX.Element | null {
  if (!pending) {
    return null
  }

  const host = hostnameFromOrigin(pending.origin) ?? pending.origin

  const bannerText = pending.isUpdate
    ? translate(
        'auto.components.browser.pane.PasswordSaveBanner.updatePrompt',
        'Update password for {{value0}}?',
        { value0: host }
      )
    : translate(
        'auto.components.browser.pane.PasswordSaveBanner.savePrompt',
        'Save password for {{value0}}?',
        { value0: host }
      )

  const saveLabel = pending.isUpdate
    ? translate('auto.components.browser.pane.PasswordSaveBanner.update', 'Update')
    : translate('auto.components.browser.pane.PasswordSaveBanner.save', 'Save')

  return (
    <div className="flex items-center gap-2 border-b border-border/60 bg-background px-3 py-1.5 text-xs text-foreground">
      <span className="min-w-0 flex-1 truncate">{bannerText}</span>
      <Button size="xs" variant="default" className="h-6 shrink-0" onClick={onSave}>
        {saveLabel}
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
        onClick={onDismiss}
        aria-label={translate('auto.components.browser.pane.PasswordSaveBanner.dismiss', 'Dismiss')}
      >
        <X className="size-3" />
      </Button>
    </div>
  )
}
