import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { NativeChatQueueSendConfirm } from './use-native-chat-held-queue-composer-send'

/** Asks, before a message sent over a held queue, whether to clear the cards first. */
export function NativeChatQueueSendConfirmDialog({
  confirm,
  focusComposer
}: {
  confirm: NativeChatQueueSendConfirm | null
  /** Where focus goes whichever way it closes. */
  focusComposer: () => void
}): React.JSX.Element | null {
  if (!confirm) {
    return null
  }
  return (
    <Dialog
      open={confirm.open}
      onOpenChange={(isOpen) => {
        if (!isOpen) {
          confirm.dismiss()
        }
      }}
    >
      <DialogContent
        className="max-w-sm sm:max-w-sm"
        showCloseButton={false}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          focusComposer()
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {translate('components.native-chat.queuedMessages.sendConfirmTitle', 'Send message?')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'components.native-chat.queuedMessages.sendConfirmBody',
              'You are about to send a message. Do you want to clear the {{count}} messages previously queued?',
              { count: confirm.count }
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="destructive" size="sm" onClick={confirm.clearQueue}>
            {translate('components.native-chat.queuedMessages.sendConfirmClear', 'Clear queue')}
          </Button>
          <Button type="button" size="sm" autoFocus onClick={confirm.sendMessage}>
            {translate('components.native-chat.queuedMessages.sendConfirmSend', 'Send message')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
