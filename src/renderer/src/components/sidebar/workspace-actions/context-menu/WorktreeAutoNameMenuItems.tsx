import { RotateCw, X } from 'lucide-react'
import { DropdownMenuItem } from '@/components/ui/dropdown-menu'
import { useTranslate } from '@/i18n/use-translate'
import type { AutoNameFailure } from '../../workspace-card/identity/use-auto-name-failure'

/** The hover card's auto-name actions for keyboard use: Radix keeps hover-card content out of Tab's reach. */
export function WorktreeAutoNameMenuItems({
  failure,
  disabled
}: {
  failure: AutoNameFailure
  disabled: boolean
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <>
      {failure.canRetry ? (
        <DropdownMenuItem onSelect={failure.tryAgain} disabled={disabled || failure.retrying}>
          <RotateCw className="size-3.5" />
          {t('auto.components.sidebar.WorktreeContextMenu.retryAutoName', 'Retry Auto-Name')}
        </DropdownMenuItem>
      ) : null}
      {failure.canDismiss ? (
        <DropdownMenuItem
          onSelect={failure.dismiss}
          disabled={disabled || failure.retrying || failure.dismissing}
        >
          <X className="size-3.5" />
          {t(
            'auto.components.sidebar.WorktreeContextMenu.dismissAutoNameError',
            'Dismiss Auto-Name Error'
          )}
        </DropdownMenuItem>
      ) : null}
    </>
  )
}
