import { X } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import type { RoomMessage } from '../../../../shared/rooms'

export function RoomComposerReply({
  reply,
  onCancel
}: {
  reply: RoomMessage
  onCancel: () => void
}): React.JSX.Element {
  return (
    <div className="mb-1 flex items-center gap-2 rounded bg-background/70 px-2 py-1 text-xs text-muted-foreground">
      <span className="min-w-0 flex-1 truncate">
        {translate('rooms.composer.replyingTo', 'Replying to @{{identity}}: {{body}}', {
          identity: reply.senderIdentity,
          body: reply.body
        })}
      </span>
      <button
        type="button"
        onClick={onCancel}
        aria-label={translate('rooms.composer.cancelReply', 'Cancel reply')}
      >
        <X className="size-3.5" />
      </button>
    </div>
  )
}
