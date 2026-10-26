import { AlertCircle, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { NameGenerationFailedDialog } from '../sidebar/AutoRenameFailedDialog'
import { translate } from '@/i18n/i18n'
import type { NativeChatNamingFailureControls } from './use-native-chat-naming-failure'

function regenerateLabel(naming: NativeChatNamingFailureControls): string {
  return naming.regenerating
    ? translate('tabHoverCard.namingFailure.regenerating', 'Regenerating…')
    : translate('tabHoverCard.namingFailure.regenerate', 'Regenerate name')
}

export function NativeChatNamingErrorBlock({
  naming
}: {
  naming: NativeChatNamingFailureControls
}): React.JSX.Element {
  return (
    <div className="space-y-1 border-t border-border pt-2" data-tab-hover-card-naming-error>
      <div className="flex items-start gap-1.5 font-medium text-destructive">
        <AlertCircle className="mt-0.5 size-3 shrink-0" aria-hidden />
        <span>{translate('tabHoverCard.namingFailure.title', "Couldn't name this chat")}</span>
      </div>
      <p className="pl-4.5 text-muted-foreground">
        {translate(
          'tabHoverCard.namingFailure.description',
          'The chat-name agent stopped with an error, so the chat keeps its first message as its name.'
        )}
      </p>
      <div className="flex items-center gap-1.5 pt-1 pl-4.5">
        <Button
          type="button"
          variant="destructive-chip"
          size="chip"
          onClick={() => naming.setDialogOpen(true)}
        >
          <AlertCircle />
          {translate('tabHoverCard.namingFailure.viewError', 'view error')}
        </Button>
        {naming.canRegenerate ? (
          <Button
            type="button"
            variant="outline"
            size="chip"
            disabled={naming.regenerating}
            onClick={naming.regenerate}
          >
            <RefreshCw />
            {regenerateLabel(naming)}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

export function NativeChatNamingFailedDialog({
  naming,
  chatName
}: {
  naming: NativeChatNamingFailureControls
  chatName: string
}): React.JSX.Element {
  return (
    <NameGenerationFailedDialog
      open={naming.dialogOpen}
      onOpenChange={naming.setDialogOpen}
      title={translate('tabHoverCard.namingFailure.dialogTitle', 'Chat auto-name failed')}
      description={
        <>
          {translate(
            'tabHoverCard.namingFailure.dialogDescriptionStart',
            "Orca couldn't generate a name for"
          )}{' '}
          <span className="font-medium text-foreground">{chatName}</span>{' '}
          {translate('tabHoverCard.namingFailure.dialogDescriptionEnd', 'from its first message.')}
        </>
      }
      error={naming.message}
      readFullOutput={naming.readFullOutput}
      action={
        naming.canRegenerate ? (
          <Button
            type="button"
            size="sm"
            disabled={naming.regenerating}
            onClick={() => {
              naming.regenerate()
              naming.setDialogOpen(false)
            }}
          >
            {regenerateLabel(naming)}
          </Button>
        ) : undefined
      }
    />
  )
}
