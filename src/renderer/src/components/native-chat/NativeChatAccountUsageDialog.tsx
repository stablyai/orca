import { useState } from 'react'
import { X } from 'lucide-react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { NativeChatAccountUsageCard } from './NativeChatAccountUsageCard'
import {
  readNativeChatAccountUsageModalRequest,
  type NativeChatAccountUsageModalRequest
} from './native-chat-account-usage-modal'
import { useNativeChatAccountUsage } from './use-native-chat-account-usage'

/** `/usage`'s modal: each opening mounts a fresh read of the chat's account. */
export default function NativeChatAccountUsageDialog(): React.JSX.Element | null {
  const modalData = useAppStore((s) => s.modalData)
  // The opening's chat is fixed; a fresh object per render would restart its read.
  const [request] = useState(() => readNativeChatAccountUsageModalRequest(modalData))
  return request ? <UsageDialog request={request} /> : null
}

function UsageDialog({
  request
}: {
  request: NativeChatAccountUsageModalRequest
}): React.JSX.Element {
  const closeModal = useAppStore((s) => s.closeModal)
  const usage = useNativeChatAccountUsage(request.sessionId, request.target)
  // Why: the slot has no trigger element for the dialog to hand focus back to.
  const [returnFocusTo] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null
  )
  const title = translate('components.native-chat.usage.title', 'Codex usage')
  return (
    <Dialog open onOpenChange={(open) => !open && closeModal()}>
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        surface="panel"
        className="flex max-h-[min(640px,calc(100vh-4rem))] flex-col overflow-hidden sm:max-w-[560px]"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (returnFocusTo?.isConnected) {
            returnFocusTo.focus({ preventScroll: true })
          }
        }}
      >
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-sidebar-border px-3 py-2">
          <DialogTitle size="compact">{title}</DialogTitle>
          <DialogClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="size-6"
              aria-label={translate('auto.components.ui.dialog.f26c4baeda', 'Close')}
            >
              <X className="size-3" />
            </Button>
          </DialogClose>
        </div>
        <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto">
          <NativeChatAccountUsageCard
            result={usage.result}
            notice={usage.notice}
            target={request.target}
            onRetry={usage.refresh}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}
