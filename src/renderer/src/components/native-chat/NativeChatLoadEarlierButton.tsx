import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { NativeChatLoadEarlierState } from '../../../../shared/native-chat-load-earlier'

export function NativeChatLoadEarlierButton({
  loadingEarlier,
  loadEarlierError,
  onLoadEarlier
}: NativeChatLoadEarlierState & { onLoadEarlier: () => void }): React.JSX.Element {
  const errorLabel = translate(
    'components.native-chat.loadEarlierError',
    'Couldn’t load earlier messages'
  )
  const retryLabel = translate('components.native-chat.retryLoadEarlier', 'Try again')

  return (
    <div className="flex justify-center py-1">
      <span role="status" aria-live="polite" className="sr-only">
        {loadEarlierError ? `${errorLabel}. ${retryLabel}` : ''}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        onClick={onLoadEarlier}
        disabled={loadingEarlier}
        aria-label={loadEarlierError ? `${errorLabel}. ${retryLabel}` : undefined}
        className="h-auto flex-col gap-0 py-1 text-muted-foreground"
      >
        {loadingEarlier ? (
          translate('components.native-chat.loadingEarlier', 'Loading…')
        ) : loadEarlierError ? (
          <>
            <span className="text-destructive">{errorLabel}</span>
            <span>{retryLabel}</span>
          </>
        ) : (
          translate('components.native-chat.loadEarlier', 'Load earlier messages')
        )}
      </Button>
    </div>
  )
}
