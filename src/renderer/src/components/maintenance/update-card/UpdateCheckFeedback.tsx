import { AlertCircle, Check, Loader2, X } from 'lucide-react'
import { Button } from '../../ui/button'
import { translate } from '@/i18n/i18n'

export function UpdateCheckFeedback({
  icon,
  text,
  onClose,
  action
}: {
  icon: 'spinner' | 'check' | 'error'
  text: string
  onClose?: () => void
  action?: { label: string; url: string }
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-3 p-3">
      <div className="shrink-0 text-muted-foreground">
        {icon === 'spinner' && <Loader2 className="size-4 animate-spin" />}
        {icon === 'check' && <Check className="size-4" />}
        {icon === 'error' && <AlertCircle className="size-4" />}
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm truncate">{text}</p>
        {action && (
          <button
            type="button"
            className="text-xs text-muted-foreground underline hover:text-foreground mt-0.5"
            onClick={() => void window.api.shell.openUrl(action.url)}
          >
            {action.label}
          </button>
        )}
      </div>
      {onClose && (
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          onClick={onClose}
          aria-label={translate('auto.components.UpdateCard.a726967bd3', 'Dismiss')}
        >
          <X className="size-3.5" />
        </Button>
      )}
    </div>
  )
}
