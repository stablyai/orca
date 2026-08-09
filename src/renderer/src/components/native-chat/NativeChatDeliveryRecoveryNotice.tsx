import { AlertTriangle } from 'lucide-react'
import { translate } from '../../i18n/i18n'
import { Button } from '../ui/button'

export function NativeChatDeliveryRecoveryNotice({
  onShowTerminal
}: {
  onShowTerminal?: () => void
}): React.JSX.Element {
  return (
    <div className="shrink-0 bg-background px-3 pt-2 sm:px-4">
      <div className="mx-auto flex w-full max-w-4xl items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 text-card-foreground shadow-xs">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          <AlertTriangle className="size-4" aria-hidden="true" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            {translate('components.native-chat.deliveryRecovery.title', 'Message wasn’t sent')}
          </p>
          <p className="text-xs text-muted-foreground">
            {translate(
              'components.native-chat.deliveryRecovery.description',
              'The terminal may be waiting for input. Your message is still in the composer.'
            )}
          </p>
        </div>
        <Button type="button" variant="secondary" size="sm" onClick={onShowTerminal}>
          {translate('components.native-chat.toggle.showTerminal', 'Show terminal')}
        </Button>
      </div>
    </div>
  )
}
