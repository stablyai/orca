import { useState } from 'react'
import { useAppStore } from '@/store'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { useTranslate } from '@/i18n/use-translate'
import { NativeChatHookReview } from './NativeChatHookReview'
import {
  readNativeChatHooksModalRequest,
  type NativeChatHooksModalRequest
} from './native-chat-hooks-modal'
import { useNativeChatHooks } from './use-native-chat-hooks'

export default function NativeChatHooksDialog(): React.JSX.Element | null {
  const modalData = useAppStore((state) => state.modalData)
  const [request] = useState(() => readNativeChatHooksModalRequest(modalData))
  return request ? <HooksDialog request={request} /> : null
}

function HooksDialog({ request }: { request: NativeChatHooksModalRequest }): React.JSX.Element {
  const t = useTranslate()
  const closeModal = useAppStore((state) => state.closeModal)
  const { result, busy, error, load } = useNativeChatHooks(request)
  const [returnFocusTo] = useState(() =>
    document.activeElement instanceof HTMLElement ? document.activeElement : null
  )
  return (
    <Dialog open onOpenChange={(open) => !open && closeModal()}>
      <DialogContent
        surface="security"
        className="flex max-h-[80vh] flex-col overflow-hidden sm:max-w-xl"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (returnFocusTo?.isConnected) {
            returnFocusTo.focus({ preventScroll: true })
          }
        }}
      >
        <div className="space-y-2 p-4 pr-10">
          <DialogTitle size="compact">
            {t('components.native-chat.hooks.title', 'Review Codex hooks')}
          </DialogTitle>
          <DialogDescription>
            {t(
              'components.native-chat.hooks.warning',
              'Hooks run commands on the execution host. Trust only commands you understand. Trust is saved in this chat’s Codex configuration and applies wherever the same hook is used, until its contents change.'
            )}
          </DialogDescription>
        </div>
        <div
          className="scrollbar-sleek min-h-0 space-y-3 overflow-y-auto px-4 pb-4"
          aria-busy={busy}
        >
          {busy ? (
            <p role="status" className="text-sm text-muted-foreground">
              {t('components.native-chat.hooks.loading', 'Checking Codex hooks…')}
            </p>
          ) : null}
          {error ? (
            <div role="alert" className="space-y-1 text-sm">
              <p>
                {t(
                  'components.native-chat.hooks.failed',
                  'Could not confirm hook trust. Refresh to check its current state. This requires a Codex version with hooks support.'
                )}
              </p>
              <pre className="whitespace-pre-wrap break-all text-chat-code">{error}</pre>
            </div>
          ) : null}
          {result ? (
            <>
              <p className="break-all text-xs text-muted-foreground">{result.cwd}</p>
              {!result.live ? (
                <p className="text-xs text-muted-foreground">
                  {t(
                    'components.native-chat.hooks.resting',
                    'Showing workspace and user hooks. Start the chat to include hooks from its selected environments and plugins.'
                  )}
                </p>
              ) : null}
              {[...new Set(result.warnings)].map((warning) => (
                <p key={warning} role="status" className="text-sm text-muted-foreground">
                  {warning}
                </p>
              ))}
              {result.hooks.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  {t('components.native-chat.hooks.empty', 'No hooks found for this chat.')}
                </p>
              ) : null}
              {result.hooks.map((hook) => (
                <NativeChatHookReview
                  key={hook.key}
                  hook={hook}
                  busy={busy}
                  onTrust={() =>
                    void load({ scope: result.scope, key: hook.key, currentHash: hook.currentHash })
                  }
                />
              ))}
            </>
          ) : null}
        </div>
        <div className="flex justify-end gap-2 border-t border-border p-3">
          <Button variant="ghost" size="sm" onClick={closeModal}>
            {t('auto.components.ui.dialog.f26c4baeda', 'Close')}
          </Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void load()}>
            {t('components.native-chat.hooks.refresh', 'Refresh')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
