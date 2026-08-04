import { useEffect, useId, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { translate } from '@/i18n/i18n'
import {
  BROWSER_JAVASCRIPT_DIALOG_PROMPT_MAX_CHARS,
  type BrowserJavaScriptDialogOpenedEvent
} from '../../../../shared/browser-javascript-dialog'

type BrowserJavaScriptDialogOverlayProps = {
  dialog: BrowserJavaScriptDialogOpenedEvent
  isActive: boolean
  busy: boolean
  onRespond: (accept: boolean, promptText?: string) => Promise<boolean>
}

function getDialogTitle(dialog: BrowserJavaScriptDialogOpenedEvent): string {
  if (dialog.dialogType === 'confirm') {
    return translate('browser.javascriptDialog.confirmTitle', 'Page confirmation')
  }
  if (dialog.dialogType === 'prompt') {
    return translate('browser.javascriptDialog.promptTitle', 'Page prompt')
  }
  return translate('browser.javascriptDialog.alertTitle', 'Page alert')
}

export function BrowserJavaScriptDialogOverlay({
  dialog,
  isActive,
  busy,
  onRespond
}: BrowserJavaScriptDialogOverlayProps): React.JSX.Element {
  const titleId = useId()
  const messageId = useId()
  const containerRef = useRef<HTMLDivElement | null>(null)
  const primaryButtonRef = useRef<HTMLButtonElement | null>(null)
  const promptInputRef = useRef<HTMLInputElement | null>(null)
  const [promptText, setPromptText] = useState(dialog.defaultPromptText)

  useEffect(() => {
    if (!isActive) {
      return
    }
    const frame = requestAnimationFrame(() => {
      if (dialog.dialogType === 'prompt') {
        promptInputRef.current?.focus()
        promptInputRef.current?.select()
      } else {
        primaryButtonRef.current?.focus()
      }
    })
    return () => cancelAnimationFrame(frame)
  }, [dialog.dialogType, isActive])

  const accept = (): void => {
    if (!busy) {
      void onRespond(true, dialog.dialogType === 'prompt' ? promptText : undefined)
    }
  }
  const dismiss = (): void => {
    if (!busy) {
      void onRespond(false)
    }
  }

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      className="absolute inset-0 z-40 flex items-center justify-center bg-black/35 p-4 backdrop-blur-[1px]"
      role={dialog.dialogType === 'alert' ? 'alertdialog' : 'dialog'}
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={messageId}
      data-testid="browser-javascript-dialog"
      onKeyDown={(event) => {
        if (event.nativeEvent.isComposing || busy) {
          return
        }
        if (event.key === 'Tab') {
          const focusable = containerRef.current?.querySelectorAll<HTMLElement>(
            'button:not([disabled]), input:not([disabled])'
          )
          if (!focusable || focusable.length === 0) {
            return
          }
          const first = focusable[0]
          const last = focusable.item(focusable.length - 1)
          const target = event.shiftKey
            ? document.activeElement === first
              ? last
              : null
            : document.activeElement === last
              ? first
              : null
          if (target) {
            event.preventDefault()
            target.focus()
          }
        } else if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          if (dialog.dialogType === 'alert') {
            accept()
          } else {
            dismiss()
          }
        } else if (event.key === 'Enter') {
          event.preventDefault()
          event.stopPropagation()
          accept()
        }
      }}
    >
      <div className="flex max-h-full w-[min(28rem,calc(100%-1rem))] flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-[0_10px_24px_rgba(0,0,0,0.18)]">
        <div className="scrollbar-sleek min-h-0 space-y-3 overflow-y-auto p-5">
          <div className="space-y-1">
            <h2 id={titleId} className="text-sm font-semibold">
              {getDialogTitle(dialog)}
            </h2>
            <p className="truncate font-mono text-[11px] text-muted-foreground" dir="ltr">
              {dialog.origin}
            </p>
          </div>
          <p
            id={messageId}
            className="scrollbar-sleek max-h-48 overflow-y-auto text-sm leading-6 whitespace-pre-wrap [overflow-wrap:anywhere]"
            dir="auto"
          >
            {dialog.message}
          </p>
          {dialog.dialogType === 'prompt' ? (
            <div>
              <label htmlFor={`${titleId}-input`} className="sr-only">
                {translate('browser.javascriptDialog.promptLabel', 'Response')}
              </label>
              <Input
                ref={promptInputRef}
                id={`${titleId}-input`}
                value={promptText}
                maxLength={BROWSER_JAVASCRIPT_DIALOG_PROMPT_MAX_CHARS}
                disabled={busy}
                onChange={(event) => setPromptText(event.target.value)}
              />
            </div>
          ) : null}
        </div>
        <div className="flex justify-end gap-2 border-t border-border bg-muted/20 px-5 py-3">
          {dialog.dialogType !== 'alert' ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={dismiss}>
              {translate('browser.javascriptDialog.cancel', 'Cancel')}
            </Button>
          ) : null}
          <Button ref={primaryButtonRef} size="sm" disabled={busy} onClick={accept}>
            {translate('browser.javascriptDialog.ok', 'OK')}
          </Button>
        </div>
      </div>
    </div>
  )
}
