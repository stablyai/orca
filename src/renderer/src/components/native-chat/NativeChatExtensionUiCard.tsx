import { useState, type ReactNode } from 'react'
import { HelpCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import type {
  OmpRpcExtensionUiRequestFrame,
  OmpRpcExtensionUiResponse
} from '../../../../shared/omp-rpc-protocol'

export type NativeChatExtensionUiCardProps = {
  request: OmpRpcExtensionUiRequestFrame
  onAnswer: (response: OmpRpcExtensionUiResponse) => void
}

/**
 * Native renderer for an OMP RPC `extension_ui_request` (D7): the RPC-owned
 * pane's only surface for tool approval, free-form confirmation, and text
 * input — OMP has no dedicated approval frame. The reducer only ever forwards
 * select/confirm/input/editor here; every other method (notify/setStatus/
 * setWidget/...) is log-and-ignore upstream. Docked above the composer like
 * NativeChatApprovalCard, one request at a time (the reducer queues the rest).
 */
export function NativeChatExtensionUiCard({
  request,
  onAnswer
}: NativeChatExtensionUiCardProps): React.JSX.Element {
  const [text, setText] = useState('')
  const timeoutNotice = request.timeout ? (
    <p className="mt-1 text-[11px] text-muted-foreground">
      {translate(
        'components.native-chat.extensionUi.autoResolves',
        'Resolves automatically if left unanswered.'
      )}
    </p>
  ) : null

  if (request.method === 'select') {
    const options = request.options ?? []
    return (
      <ExtensionUiCardShell title={request.title} message={request.message} footer={timeoutNotice}>
        <div className="flex flex-wrap gap-2">
          {options.map((option, index) => (
            <Button
              key={option}
              type="button"
              variant={index === 0 ? 'default' : 'outline'}
              size="sm"
              title={request.optionDetails?.[index]?.description}
              onClick={() =>
                onAnswer({ type: 'extension_ui_response', id: request.id, value: option })
              }
            >
              {option}
            </Button>
          ))}
          {/* Why (F6): the pane's only input while a request is pending must
           *  always offer a decline path — an options list, even a
           *  legitimately empty one, is never the only way out. */}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() =>
              onAnswer({ type: 'extension_ui_response', id: request.id, cancelled: true })
            }
          >
            {translate('components.native-chat.extensionUi.cancel', 'Cancel')}
          </Button>
        </div>
      </ExtensionUiCardShell>
    )
  }

  if (request.method === 'confirm') {
    return (
      <ExtensionUiCardShell title={request.title} message={request.message} footer={timeoutNotice}>
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            onClick={() =>
              onAnswer({ type: 'extension_ui_response', id: request.id, confirmed: true })
            }
          >
            {translate('components.native-chat.extensionUi.confirm', 'Confirm')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() =>
              onAnswer({ type: 'extension_ui_response', id: request.id, confirmed: false })
            }
          >
            {translate('components.native-chat.extensionUi.cancel', 'Cancel')}
          </Button>
        </div>
      </ExtensionUiCardShell>
    )
  }

  // 'input' | 'editor' — every other request.method reaches the reducer's
  // log-and-ignore branch and never becomes a pendingExtensionUiRequest.
  const trimmed = text.trim()
  const submit = (): void => {
    if (!trimmed) {
      return
    }
    onAnswer({ type: 'extension_ui_response', id: request.id, value: text })
  }
  return (
    <ExtensionUiCardShell title={request.title} message={request.message} footer={timeoutNotice}>
      <div className="flex gap-2">
        <Input
          autoFocus
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              submit()
            }
          }}
          placeholder={translate(
            'components.native-chat.extensionUi.inputPlaceholder',
            'Type your answer…'
          )}
        />
        <Button type="button" size="sm" disabled={!trimmed} onClick={submit}>
          {translate('components.native-chat.extensionUi.submit', 'Submit')}
        </Button>
        {/* Why (F6): a request without a `timeout` would otherwise wedge the
         *  pane indefinitely — the composer is unmounted while a request is
         *  pending, so this card must always offer a way out. */}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() =>
            onAnswer({ type: 'extension_ui_response', id: request.id, cancelled: true })
          }
        >
          {translate('components.native-chat.extensionUi.cancel', 'Cancel')}
        </Button>
      </div>
    </ExtensionUiCardShell>
  )
}

function ExtensionUiCardShell({
  title,
  message,
  footer,
  children
}: {
  title?: string
  message?: string
  footer: ReactNode
  children: ReactNode
}): React.JSX.Element {
  return (
    <div className="shrink-0 bg-background">
      <div className="mx-auto w-full max-w-4xl px-3 pt-2 pb-1 sm:px-4">
        <div className="flex w-full flex-col gap-2 rounded-lg border border-input bg-card px-4 py-3 shadow-xs">
          <div className="flex items-start gap-2">
            <HelpCircle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              {title ? <p className="text-sm font-semibold text-foreground">{title}</p> : null}
              {message ? (
                <p className="mt-0.5 break-words text-xs text-muted-foreground">{message}</p>
              ) : null}
            </div>
          </div>
          {children}
          {footer}
        </div>
      </div>
    </div>
  )
}
